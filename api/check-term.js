const { Redis } = require('@upstash/redis');

function cleanJSON(text) {
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

let _redis;
function getRedis() {
  if (!_redis) _redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return _redis;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 요청' });

  const { term } = req.body;
  if (!term) return res.status(400).json({ error: '용어를 입력해주세요.' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });

  const prompt = `"${term}"이(가) AI/ML/딥러닝/머신러닝 관련 기술 용어인지 판단해주세요.

반드시 아래 JSON 형식만 반환하세요. 마크다운 코드블록 포함 금지.

{
  "isAiTerm": true 또는 false,
  "desc": "용어에 대한 한 줄 설명 (한국어, AI 용어일 때만)",
  "reason": "판단 이유 한 줄"
}

판단 기준:
- AI/ML/딥러닝/NLP/컴퓨터비전/강화학습 관련이면 true
- 클라우드/DevOps/인프라/네트워크/보안 관련이면 true
- 프로그래밍 언어/프레임워크/데이터베이스 관련이면 true
- 반도체/하드웨어/IoT/블록체인/핀테크 관련이면 true
- 일반 IT 용어라도 기술 분야와 밀접하면 true
- 기술과 무관한 일반 단어/개념이면 false`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
        })
      }
    );

    if (response.status === 429) {
      return res.status(429).json({
        error: 'AI 확인 서비스가 일시적으로 혼잡합니다. 잠시 후 다시 시도해주세요.'
      });
    }

    if (!response.ok) {
      return res.status(500).json({ error: '일시적인 오류가 발생했습니다. 다시 시도해주세요.' });
    }

    const data = await response.json();
    const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let parsed;
    try {
      parsed = JSON.parse(cleanJSON(raw));
    } catch {
      return res.status(500).json({ error: '일시적인 오류가 발생했습니다. 다시 시도해주세요.' });
    }

    // AI/Tech 용어이면 Redis에 저장
    if (parsed.isAiTerm) {
      try {
        const termData = { term, desc: parsed.desc || term, addedAt: new Date().toISOString() };
        await getRedis().hset('custom_terms', { [term]: JSON.stringify(termData) });
      } catch (redisErr) {
        console.error('[Redis 저장 오류]', redisErr.message);
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: '일시적인 오류가 발생했습니다. 다시 시도해주세요.' });
  }
};
