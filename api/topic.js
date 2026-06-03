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

  const { mode, articles, term, summary } = req.body;
  let prompt = '';

  if (mode === 'news' && articles?.length > 0) {
    const articleText = articles
      .map((a, i) => `${i + 1}. ${a.title}\n${a.description || ''}`)
      .join('\n\n');
    prompt = `다음 AI 관련 영어 뉴스를 바탕으로 한국어 스피치 연습용 토론 주제 1문장을 만들어주세요.\n\n뉴스:\n${articleText}\n\n요구사항:\n- 반드시 한국어로\n- 의견을 나눌 수 있는 개방형 질문\n- 주제 문장 1개만 출력 (설명 없이)`;
  } else if (mode === 'term') {
    prompt = `AI 용어 "${term}"을 주제로 한국어 스피치 연습용 토론 주제 1문장을 만들어주세요.\n\n요구사항:\n- 반드시 한국어로\n- 의견을 나눌 수 있는 개방형 질문\n- 주제 문장 1개만 출력 (설명 없이)`;
  } else if (mode === 'custom' && summary) {
    prompt = `다음 내용을 바탕으로 한국어 스피치 연습용 토론 주제 1문장을 만들어주세요.\n\n내용:\n${summary}\n\n요구사항:\n- 반드시 한국어로\n- 의견을 나눌 수 있는 개방형 질문\n- 주제 문장 1개만 출력 (설명 없이)`;
  } else {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 200 }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `Gemini API 오류: ${response.status}`);
    }

    const data = await response.json();
    const topic = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.status(200).json({ topic });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
