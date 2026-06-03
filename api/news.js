// 국내/국외 각각 별도 캐시 (1시간)
let cacheD = { articles: [], timestamp: 0 };
let cacheI = { articles: [], timestamp: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000;

const LATEST = 'https://newsdata.io/api/1/latest';

async function fetchNews(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.status === 'success' ? (data.results || []) : [];
  } catch {
    return [];
  }
}

function buildQuery(base, params) {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

// 국내/국외 AI 키워드
const DOMESTIC_KW = ['인공지능', 'AI', 'ChatGPT', 'LLM', '딥러닝', '머신러닝', '생성AI', '챗GPT', '거대언어모델'];
const INTL_KW     = ['artificial intelligence', 'AI', 'ChatGPT', 'LLM', 'machine learning', 'deep learning', 'generative AI', 'large language model'];

// 키워드 포함 기사 필터
function filterByKW(list, kwList) {
  return list.filter(a => {
    const text = `${a.title || ''} ${a.description || ''}`.toLowerCase();
    return kwList.some(kw => text.includes(kw.toLowerCase()));
  });
}

// 키워드 많이 포함된 기사가 상단 (관련도 정렬)
function sortByRelevance(list, kwList) {
  return [...list].sort((a, b) => {
    const score = item => {
      const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
      return kwList.filter(kw => text.includes(kw.toLowerCase())).length;
    };
    return score(b) - score(a);
  });
}

// 국내 뉴스: AI 필터 + 관련도 정렬, 3개 미만 시 timeframe=7 재시도
async function getDomesticRaw(apiKey) {
  // 1단계: 핵심 AI 키워드 + technology + country=kr
  let raw = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'ko', country: 'kr',
    q: '인공지능 OR AI OR ChatGPT OR LLM OR 딥러닝 OR 머신러닝 OR 생성AI',
    category: 'technology', size: 10
  }));
  let filtered = sortByRelevance(filterByKW(raw, DOMESTIC_KW), DOMESTIC_KW);
  console.log('[국내뉴스] 1단계: 수집', raw.length, '건, 필터 후', filtered.length, '건');
  if (filtered.length >= 3) return filtered.slice(0, 3);

  // 2단계: timeframe=7 재시도 (3개 미만)
  raw = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'ko',
    q: '인공지능 OR AI OR ChatGPT OR LLM OR 딥러닝 OR 머신러닝', timeframe: 7, size: 10
  }));
  filtered = sortByRelevance(filterByKW(raw, DOMESTIC_KW), DOMESTIC_KW);
  console.log('[국내뉴스] 2단계(timeframe=7): 수집', raw.length, '건, 필터 후', filtered.length, '건');
  if (filtered.length >= 3) return filtered.slice(0, 3);

  // 3단계: 폭넓은 기술 키워드 (최소 보장)
  raw = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'ko',
    q: '테크 OR 기술 OR IT OR 스타트업', timeframe: 7, size: 10
  }));
  const extra = sortByRelevance(filterByKW(raw, DOMESTIC_KW), DOMESTIC_KW);
  const combined = [...filtered, ...extra];
  console.log('[국내뉴스] 3단계: 수집', raw.length, '건, 최종', combined.length, '건');
  return (combined.length > 0 ? combined : raw).slice(0, 3);
}

// 국외 뉴스: AI 필터 + 관련도 정렬, 3개 미만 시 timeframe=7 재시도
async function getInternationalRaw(apiKey) {
  // 1단계: 핵심 AI 키워드 + technology + country=us,gb
  let raw = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'en', country: 'us,gb',
    q: 'artificial intelligence OR AI OR LLM OR ChatGPT OR "machine learning"',
    category: 'technology', size: 10, prioritydomain: 'top'
  }));
  let filtered = sortByRelevance(filterByKW(raw, INTL_KW), INTL_KW);
  console.log('[국외뉴스] 1단계: 수집', raw.length, '건, 필터 후', filtered.length, '건');
  if (filtered.length >= 3) return filtered.slice(0, 3);

  // 2단계: timeframe=7 재시도 (3개 미만)
  raw = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'en',
    q: 'artificial intelligence OR machine learning OR deep learning OR LLM', timeframe: 7, size: 10
  }));
  filtered = sortByRelevance(filterByKW(raw, INTL_KW), INTL_KW);
  console.log('[국외뉴스] 2단계(timeframe=7): 수집', raw.length, '건, 필터 후', filtered.length, '건');
  return (filtered.length > 0 ? filtered : raw).slice(0, 3);
}

function parseArticles(results) {
  return (results || []).map(a => ({
    title:       a.title       || '',
    description: a.description || '',
    link:        a.link        || '',
    pubDate:     a.pubDate     || '',
    source:      a.source_id   || ''
  }));
}

const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

function cleanJSON(text) {
  // 마크다운 코드 블록 제거 후 JSON 파싱
  return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

// 기사 1개를 Gemini로 개별 분석 (실패 시 2초 후 1회 재시도)
async function analyzeOneArticle(article, GEMINI_API_KEY) {
  const titleFallback = () => ({
    summary:  `${article.title}에 관한 기사입니다.`,
    keywords: ['AI'],
    insight:  '원문을 확인해주세요.'
  });

  const prompt = `아래 뉴스 기사를 한국어로 분석해주세요.
제목: ${article.title}
내용: ${article.description || '(내용 없음)'}

아래 JSON 형식으로만 답하세요:
{
  "summary": "한글 요약 3~4문장",
  "keywords": ["키워드1", "키워드2", "키워드3"],
  "insight": "핵심 인사이트 1~2문장"
}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(GEMINI_URL(GEMINI_API_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500, responseMimeType: 'application/json' }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Gemini] ${attempt}차 HTTP ${res.status} (${article.title}):`, errText.slice(0, 300));
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
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
      console.error(`[Gemini] ${attempt}차 예외 (${article.title}):`, err.message);
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return titleFallback();
    }
  }
  return titleFallback();
}

// 기사 목록 전체를 병렬 분석 (각 기사별 독립 재시도)
async function analyzeArticles(rawList, GEMINI_API_KEY) {
  if (rawList.length === 0) return [];

  const analyses = await Promise.all(rawList.map(a => analyzeOneArticle(a, GEMINI_API_KEY)));

  return rawList.map((a, i) => ({
    title:    a.title,
    source:   a.source,
    pubDate:  a.pubDate,
    link:     a.link,
    summary:  analyses[i].summary,
    keywords: analyses[i].keywords,
    insight:  analyses[i].insight
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
  const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;

  if (!NEWSDATA_API_KEY) return res.status(500).json({ error: 'NEWSDATA_API_KEY가 설정되지 않았습니다.' });
  if (!GEMINI_API_KEY)   return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });

  const type = req.query.type;

  try {
    // ── 국내 뉴스 ──
    if (type === 'domestic') {
      if (Date.now() - cacheD.timestamp < CACHE_TTL && cacheD.articles.length > 0) {
        return res.status(200).json({ domestic: cacheD.articles, cached: true });
      }
      const raw      = parseArticles(await getDomesticRaw(NEWSDATA_API_KEY));
      const articles = await analyzeArticles(raw, GEMINI_API_KEY);
      cacheD = { articles, timestamp: Date.now() };
      return res.status(200).json({ domestic: articles });
    }

    // ── 국외 뉴스 ──
    if (type === 'international') {
      if (Date.now() - cacheI.timestamp < CACHE_TTL && cacheI.articles.length > 0) {
        return res.status(200).json({ international: cacheI.articles, cached: true });
      }
      const raw      = parseArticles(await getInternationalRaw(NEWSDATA_API_KEY));
      const articles = await analyzeArticles(raw, GEMINI_API_KEY);
      cacheI = { articles, timestamp: Date.now() };
      return res.status(200).json({ international: articles });
    }

    res.status(400).json({ error: 'type 파라미터가 필요합니다 (domestic 또는 international)' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
