// In-memory cache (동일 서버리스 인스턴스 내에서 1시간 유지)
let cache = { domestic: [], international: [], timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
  const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;

  if (!NEWSDATA_API_KEY) return res.status(500).json({ error: 'NEWSDATA_API_KEY가 설정되지 않았습니다.' });
  if (!GEMINI_API_KEY)   return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });

  // 캐시가 유효하면 즉시 반환
  if (Date.now() - cache.timestamp < CACHE_TTL && cache.domestic.length > 0) {
    return res.status(200).json({ domestic: cache.domestic, international: cache.international, cached: true });
  }

  try {
    const BASE = 'https://newsdata.io/api/1/latest';

    // 국내/국외 뉴스 병렬 수집
    const [domesticRes, intlRes] = await Promise.all([
      fetch(`${BASE}?apikey=${NEWSDATA_API_KEY}&q=AI+인공지능&language=ko&country=kr&size=5`),
      fetch(`${BASE}?apikey=${NEWSDATA_API_KEY}&q=artificial+intelligence+LLM&language=en&country=us,gb&size=5`)
    ]);

    if (!domesticRes.ok) throw new Error(`국내 뉴스 수집 오류: ${domesticRes.status}`);
    if (!intlRes.ok)     throw new Error(`국외 뉴스 수집 오류: ${intlRes.status}`);

    const [domesticData, intlData] = await Promise.all([domesticRes.json(), intlRes.json()]);

    const parseRaw = (results) => (results || []).map(a => ({
      title: a.title || '',
      description: a.description || '',
      link: a.link || '',
      pubDate: a.pubDate || '',
      source: a.source_id || ''
    }));

    const domesticRaw = parseRaw(domesticData.results);
    const intlRaw     = parseRaw(intlData.results);
    const allRaw      = [...domesticRaw, ...intlRaw];

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
          title:   a.title,
          source:  a.source,
          pubDate: a.pubDate,
          link:    a.link,
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
