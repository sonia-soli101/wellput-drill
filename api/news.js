// 국내/국외 각각 별도 캐시 (1시간)
let cacheD = { articles: [], timestamp: 0 };
let cacheI = { articles: [], timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;

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

// 국내 뉴스: 단계적 폴백 (최소 1개 보장)
async function getDomesticRaw(apiKey) {
  // 1단계: AI 핵심 키워드 + technology 카테고리
  let url = buildQuery(LATEST, {
    apikey: apiKey, language: 'ko', country: 'kr',
    q: '인공지능 OR AI OR 챗GPT OR LLM OR 머신러닝',
    category: 'technology', size: 10
  });
  let results = await fetchNews(url);
  console.log('[국내뉴스] 1단계:', results.length, '건');
  if (results.length >= 5) return results.slice(0, 5);

  // 2단계: country 제거 + timeframe 확장
  url = buildQuery(LATEST, {
    apikey: apiKey, language: 'ko',
    q: '인공지능 OR AI', timeframe: 7, size: 10
  });
  results = await fetchNews(url);
  console.log('[국내뉴스] 2단계:', results.length, '건');
  if (results.length >= 5) return results.slice(0, 5);

  // 3단계: 기술 일반 키워드로 확장
  url = buildQuery(LATEST, {
    apikey: apiKey, language: 'ko',
    q: '테크 OR 기술 OR 스타트업', timeframe: 7, size: 10
  });
  results = await fetchNews(url);
  console.log('[국내뉴스] 3단계:', results.length, '건');
  return results.slice(0, 5);
}

// 국외 뉴스: 단계적 폴백
async function getInternationalRaw(apiKey) {
  // 1단계: AI 핵심 키워드 + technology 카테고리
  let results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'en', country: 'us,gb',
    q: 'artificial intelligence OR AI OR LLM OR ChatGPT',
    category: 'technology', size: 10, prioritydomain: 'top'
  }));
  console.log('[국외뉴스] 1단계:', results.length, '건');
  if (results.length >= 5) return results.slice(0, 5);

  // 2단계: country 제거 + timeframe 확장
  results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, language: 'en',
    q: 'artificial intelligence OR machine learning', timeframe: 7, size: 10
  }));
  console.log('[국외뉴스] 2단계:', results.length, '건');
  return results.slice(0, 5);
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

// Gemini로 기사 분석 후 최종 article 배열 반환
async function analyzeArticles(rawList, GEMINI_API_KEY) {
  if (rawList.length === 0) return [];

  const articleTexts = rawList
    .map((a, i) => `기사 ${i + 1}:\n제목: ${a.title}\n내용: ${a.description || '(내용 없음)'}`)
    .join('\n\n');

  const prompt = `다음 AI 관련 뉴스 기사들을 각각 한국어로 분석해주세요.
한국어 기사도 영어 기사도 모두 한국어로 요약하세요. 내용이 없으면 제목 기반으로 추론하세요.

${articleTexts}

반드시 아래 JSON 배열 형식으로만 응답하세요 (기사 순서 유지, 총 ${rawList.length}개 항목):
[
  {
    "summary": "핵심 내용 2~3문장 한국어 요약",
    "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3"],
    "insight": "이 기사가 시사하는 핵심 인사이트 1문장"
  }
]`;

  let analyses = rawList.map(() => ({ summary: '', keywords: [], insight: '' }));
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000, responseMimeType: 'application/json' }
        })
      }
    );
    if (geminiRes.ok) {
      const gd = await geminiRes.json();
      const raw = gd.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      try { analyses = JSON.parse(raw); } catch {}
    }
  } catch {}

  return rawList.map((a, i) => {
    const an = analyses[i] || {};
    return {
      title:    a.title,
      source:   a.source,
      pubDate:  a.pubDate,
      link:     a.link,
      summary:  an.summary  || '',
      keywords: Array.isArray(an.keywords) ? an.keywords : [],
      insight:  an.insight  || ''
    };
  });
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
