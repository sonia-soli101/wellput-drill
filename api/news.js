module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
  if (!NEWSDATA_API_KEY) {
    return res.status(500).json({ error: 'NEWSDATA_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&q=artificial+intelligence+LLM&language=en&category=technology&size=5`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`NewsData.io 오류: ${response.status}`);

    const data = await response.json();
    if (data.status !== 'success') throw new Error(data.message || 'NewsData.io API 오류');

    const articles = (data.results || []).map(a => ({
      title: a.title || '',
      description: a.description || '',
      link: a.link || '',
      pubDate: a.pubDate || '',
      source: a.source_id || ''
    }));

    res.status(200).json({ articles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
