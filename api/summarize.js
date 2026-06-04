function geminiError(status) {
  if (status === 429) return {
    error: 'AI 분석 서비스가 일시적으로 혼잡합니다. 잠시 후 다시 시도해주세요. (보통 1분 이내 해결됩니다)',
    isRateLimit: true
  };
  return { error: '일시적인 오류가 발생했습니다. 페이지를 새로고침 후 다시 시도해주세요.' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { type, content, url, pdfBase64 } = req.body;
  const summarizePrompt = '다음 내용을 한국어로 핵심만 4~5문장으로 요약해주세요. 요약문만 출력하세요.';

  try {
    let parts = [];

    if (type === 'url' && url) {
      const readerRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain' }
      });
      if (!readerRes.ok) throw new Error('URL에서 내용을 가져올 수 없습니다.');
      const pageText = (await readerRes.text()).slice(0, 10000);
      parts = [{ text: `${summarizePrompt}\n\n내용:\n${pageText}` }];

    } else if (type === 'text' && content) {
      parts = [{ text: `${summarizePrompt}\n\n내용:\n${content}` }];

    } else if (type === 'pdf' && pdfBase64) {
      parts = [
        { text: summarizePrompt },
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }
      ];

    } else {
      return res.status(400).json({ error: '유효한 입력(url/text/pdf)이 필요합니다.' });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
        })
      }
    );

    if (!response.ok) return res.status(200).json(geminiError(response.status));

    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.status(200).json({ summary });
  } catch (error) {
    res.status(500).json({ error: '일시적인 오류가 발생했습니다. 페이지를 새로고침 후 다시 시도해주세요.' });
  }
};
