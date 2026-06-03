const { Redis } = require('@upstash/redis');

let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type;

  if (type !== 'domestic' && type !== 'international') {
    return res.status(400).json({ error: 'type 파라미터가 필요합니다 (domestic 또는 international)' });
  }

  try {
    const key      = `news:${type}`;
    const articles = await getRedis().get(key);

    if (!articles || (Array.isArray(articles) && articles.length === 0)) {
      return res.status(200).json({
        [type]: [],
        message: '뉴스를 불러오는 중입니다. 잠시 후 다시 시도해주세요.'
      });
    }

    return res.status(200).json({ [type]: articles });
  } catch (error) {
    console.error('[Redis 오류]', error.message);
    return res.status(500).json({ error: '데이터를 불러오는 중 오류가 발생했습니다.' });
  }
};
