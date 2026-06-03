// In-memory cache (동일 서버리스 인스턴스 내에서 1시간 유지)
let cache = { domestic: [], international: [], timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;

const LATEST  = 'https://newsdata.io/api/1/latest';
const ARCHIVE = 'https://newsdata.io/api/1/news';

// NewsData.io 호출 → 결과 배열 반환 (실패 시 [])
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
  const p = new URLSearchParams(params);
  return `${base}?${p.toString()}`;
}

// 국내 뉴스: 단계적 폴백
async function getDomesticRaw(apiKey) {
  // 1단계: 오늘 국내 뉴스 (language=ko, country=kr)
  let results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, q: 'AI 인공지능', language: 'ko', country: 'kr',
    size: 10, prioritydomain: 'top'
  }));
  if (results.length >= 5) return results.slice(0, 5);

  // 2단계: country 조건 제거 (language=ko 전체)
  results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, q: 'AI 인공지능', language: 'ko',
    size: 10, prioritydomain: 'top'
  }));
  if (results.length >= 5) return results.slice(0, 5);

  // 3단계: 최근 7일 아카이브로 확장
  const archiveResults = await fetchNews(buildQuery(ARCHIVE, {
    apikey: apiKey, q: 'AI 인공지능', language: 'ko',
    size: 5
  }));
  // 두 결과 합산 후 중복 제거, 최신순 5개
  const merged = [...results, ...archiveResults];
  const seen = new Set();
  return merged.filter(a => {
    if (!a.link || seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  }).slice(0, 5);
}

// 국외 뉴스: 단계적 폴백
async function getInternationalRaw(apiKey) {
  // 1단계: 오늘 국외 뉴스 (language=en, country=us,gb)
  let results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, q: 'artificial intelligence LLM', language: 'en',
    country: 'us,gb', size: 10, prioritydomain: 'top'
  }));
  if (results.length >= 5) return results.slice(0, 5);

  // 2단계: country 조건 제거 (language=en 전체)
  results = await fetchNews(buildQuery(LATEST, {
    apikey: apiKey, q: 'artificial intelligence LLM', language: 'en',
    size: 10
  }));
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
  const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;

  if (!NEWSDATA_API_KEY) return res.status(500).json({ error: 'NEWSDATA_API_KEY가 설정되지 않았습니다.' });
  if (!GEMINI_API_KEY)   return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });

  // 캐시 유효 시 즉시 반환
  if (Date.now() - cache.timestamp < CACHE_TTL && cache.domestic.length > 0) {
    return res.status(200).json({ domestic: cache.domestic, international: cache.international, cached: true });
  }

  try {
    // 국내/국외 뉴스 병렬 수집 (각각 폴백 로직 포함)
    const [domesticRaw, intlRaw] = await Promise.all([
      getDomesticRaw(NEWSDATA_API_KEY).then(parseArticles),
      getInternationalRaw(NEWSDATA_API_KEY).then(parseArticles)
    ]);

    const allRaw = [...domesticRaw, ...intlRaw];

    if (allRaw.length === 0) {
      throw new Error('수집된 뉴스가 없습니다. API 키 또는 요금제를 확인해주세요.');
    }

    // Gemini로 전체 기사 일괄 분석 (1회 호출)
    const articleTexts = allRaw
      .map((a, i) => `기사 ${i + 1}:\n제목: ${a.title}\n내용: ${a.description || '(내용 없음)'}`)
      .join('\n\n');

    const geminiPrompt = `다음 AI 관련 뉴스 기사들을 각각 한국어로 분석해주세요.

${articleTexts}

각 기사에 대해 아래 JSON 배열 형식으로만 응답하세요 (기사 순서 유지, 다른 텍스트 없이):
[
  {
    "summary": "핵심 내용 2~3문장 한국어 요약",
    "keywords": ["핵심키워드1", "핵심키워드2", "핵심키워드3"],
    "insight": "이 기사가 시사하는 핵심 인사이트 1문장"
  }
]`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 3000,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    let analyses = allRaw.map(() => ({ summary: '', keywords: [], insight: '' }));
    if (geminiRes.ok) {
      const geminiData = await geminiRes.json();
      const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      try { analyses = JSON.parse(rawText); } catch {}
    }

    const buildArticles = (rawList, offset) =>
      rawList.map((a, i) => {
        const an = analyses[offset + i] || {};
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

    const domestic      = buildArticles(domesticRaw, 0);
    const international = buildArticles(intlRaw, domesticRaw.length);

    cache = { domestic, international, timestamp: Date.now() };
    res.status(200).json({ domestic, international });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
