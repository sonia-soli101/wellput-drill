/**
 * wellput-drill 뉴스 자동 수집 스크립트
 * GitHub Actions에서 6시간마다 실행
 * 국내/국외 AI 뉴스 각 3개 수집 → Gemini 분석 → Upstash Redis 저장
 */

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;

const NEWSDATA_BASE = 'https://newsdata.io/api/1/latest';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

// ── 키워드 필터 ──────────────────────────────────────────────
const DOMESTIC_KW = ['인공지능', 'AI', 'ChatGPT', 'LLM', '딥러닝', '머신러닝', '생성AI', '챗GPT', '거대언어모델'];
const INTL_KW     = ['artificial intelligence', 'AI', 'ChatGPT', 'LLM', 'machine learning', 'deep learning', 'generative AI', 'large language model'];

function filterByKW(list, kwList) {
  return list.filter(a => {
    const text = `${a.title || ''} ${a.description || ''}`.toLowerCase();
    return kwList.some(kw => text.includes(kw.toLowerCase()));
  });
}

function sortByRelevance(list, kwList) {
  return [...list].sort((a, b) => {
    const score = item => {
      const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
      return kwList.filter(kw => text.includes(kw.toLowerCase())).length;
    };
    return score(b) - score(a);
  });
}

// ── 뉴스 수집 ────────────────────────────────────────────────
async function fetchNews(url) {
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.status === 'success' ? (data.results || []) : [];
}

function getFromDate() {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getDomesticRaw() {
  const params = new URLSearchParams({
    apikey: NEWSDATA_API_KEY, language: 'ko', country: 'kr',
    q: '인공지능 OR AI OR ChatGPT OR LLM OR 딥러닝',
    category: 'technology', size: 10, from_date: getFromDate()
  });
  const raw = await fetchNews(`${NEWSDATA_BASE}?${params}`);
  const filtered = sortByRelevance(filterByKW(raw, DOMESTIC_KW), DOMESTIC_KW);
  console.log(`  수집 ${raw.length}건 → AI 필터 후 ${filtered.length}건`);
  return filtered.slice(0, 3);
}

async function getInternationalRaw() {
  const params = new URLSearchParams({
    apikey: NEWSDATA_API_KEY, language: 'en', country: 'us,gb',
    q: 'artificial intelligence OR AI OR ChatGPT OR LLM',
    category: 'technology', size: 10, prioritydomain: 'top', from_date: getFromDate()
  });
  const raw = await fetchNews(`${NEWSDATA_BASE}?${params}`);
  const filtered = sortByRelevance(filterByKW(raw, INTL_KW), INTL_KW);
  console.log(`  수집 ${raw.length}건 → AI 필터 후 ${filtered.length}건`);
  return filtered.slice(0, 3);
}

// ── Gemini 분석 ──────────────────────────────────────────────
function cleanJSON(text) {
  return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function analyzeArticle(article) {
  const titleFallback = () => ({
    summary:  `${article.title}에 관한 기사입니다.`,
    keywords: ['AI'],
    insight:  '원문을 확인해주세요.'
  });

  const prompt = `아래 내용을 기사 제목과 설명을 바탕으로 원문을 읽지 않아도 충분히 이해할 수 있도록 최대 10문장으로 상세하게 한국어로 요약해주세요.
제목: ${article.title}
내용: ${article.description || '(내용 없음)'}

아래 JSON 형식으로만 답하세요:
{
  "summary": "최대 10문장으로 상세한 한국어 요약",
  "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"],
  "insight": "핵심 인사이트 2~3문장"
}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 800, responseMimeType: 'application/json' }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`  [Gemini] ${attempt}차 HTTP ${res.status}:`, errText.slice(0, 200));
        if (attempt < 2) { await sleep(5000); continue; }
        return titleFallback();
      }

      const data   = await res.json();
      const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(cleanJSON(raw));

      return {
        summary:  parsed.summary  || titleFallback().summary,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : ['AI'],
        insight:  parsed.insight  || titleFallback().insight
      };
    } catch (err) {
      console.error(`  [Gemini] ${attempt}차 예외:`, err.message);
      if (attempt < 2) { await sleep(5000); continue; }
      return titleFallback();
    }
  }
  return titleFallback();
}

// ── 기사 목록 순차 분석 (기사 사이 2초 딜레이) ──────────────
async function processArticles(rawList) {
  const results = [];
  for (let i = 0; i < rawList.length; i++) {
    const a = rawList[i];
    console.log(`  [${i + 1}/${rawList.length}] ${a.title}`);
    const analysis = await analyzeArticle(a);
    results.push({
      title:    a.title      || '',
      source:   a.source_id  || '',
      pubDate:  a.pubDate    || '',
      link:     a.link       || '',
      summary:  analysis.summary,
      keywords: analysis.keywords,
      insight:  analysis.insight
    });
    if (i < rawList.length - 1) {
      console.log('  (3초 대기...)');
      await sleep(3000);
    }
  }
  return results;
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  console.log('\n=== wellput-drill 뉴스 수집 시작 ===');
  console.log('시각:', new Date().toISOString());

  // 국내 뉴스
  console.log('\n[국내 뉴스]');
  const domesticRaw      = await getDomesticRaw();
  const domesticArticles = await processArticles(domesticRaw);
  await redis.set('news:domestic', domesticArticles);
  console.log(`✅ 국내 뉴스 ${domesticArticles.length}개 Redis 저장 완료`);

  console.log('\n(국내→국외 전환 3초 대기...)');
  await sleep(3000);

  // 국외 뉴스
  console.log('\n[국외 뉴스]');
  const intlRaw      = await getInternationalRaw();
  const intlArticles = await processArticles(intlRaw);
  await redis.set('news:international', intlArticles);
  console.log(`✅ 국외 뉴스 ${intlArticles.length}개 Redis 저장 완료`);

  console.log('\n=== 수집 완료 ===');
  console.log('시각:', new Date().toISOString());
}

main().catch(err => {
  console.error('❌ 치명적 오류:', err);
  process.exit(1);
});
