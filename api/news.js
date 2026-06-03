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

// 기사 1개를 Gemini로 개별 분석
async function analyzeOneArticle(article, GEMINI_API_KEY) {
  const FALLBACK = { summary: '분석 중 오류 발생', keywords: [], insight: '분석 중 오류 발생' };

  const prompt = `아래 뉴스 기사를 한국어로 분석해주세요.
제목: ${article.title}
내용: ${article.description || '(내용 없음)'}

아래 JSON 형식으로만 답하세요:
{
  "summary": "한글 요약 3~4문장",
  "keywords": ["키워드1", "키워드2", "키워드3"],
  "insight": "핵심 인사이트 1~2문장"
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500, responseMimeType: 'application/json' }
        })
      }
    );
    if (!res.ok) return FALLBACK;

    const data = await res.json();
    const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    return {
      summary:  parsed.summary  || FALLBACK.summary,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      insight:  parsed.insight  || FALLBACK.insight
    };
  } catch {
    return FALLBACK;
  }
}

// 기사 목록 전체를 개별 Gemini 호출로 병렬 분석
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
