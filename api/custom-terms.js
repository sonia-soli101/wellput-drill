const { Redis } = require('@upstash/redis');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: 저장된 용어 목록 ──
  if (req.method === 'GET') {
    try {
      const all = await getRedis().hgetall('custom_terms');
      if (!all) return res.status(200).json({ terms: [] });

      const terms = Object.values(all).map(v =>
        typeof v === 'string' ? JSON.parse(v) : v
      );
      terms.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      return res.status(200).json({ terms });
    } catch (err) {
      return res.status(500).json({ error: '목록을 불러오는 중 오류가 발생했습니다.' });
    }
  }

  // ── DELETE: 특정 용어 삭제 ──
  if (req.method === 'DELETE') {
    const { term } = req.body;
    if (!term) return res.status(400).json({ error: '용어를 입력해주세요.' });
    try {
      await getRedis().hdel('custom_terms', term);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
    }
  }

  return res.status(405).json({ error: '허용되지 않는 요청' });
};
