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

  const TOPIC_RULES = `출력 규칙 (반드시 준수):
- 한국어 질문형 완전한 문장 1개만 출력
- 반드시 물음표(?)로 끝낼 것 — 이 규칙은 절대 예외 없음
- 찬반 토론 또는 의견 제시가 가능한 주제
- 예시: "AI 규제는 혁신을 막는가?", "챗GPT는 교육 현장을 바꿀 수 있는가?", "AI는 인간의 일자리를 대체할 것인가?"
- 번호, 따옴표, 부가 설명 없이 문장만 출력`;

  if (mode === 'news' && articles?.length > 0) {
    const articleText = articles
      .map((a, i) => `${i + 1}. ${a.title}\n${a.description || ''}`)
      .join('\n\n');
    prompt = `다음 AI 관련 영어 뉴스를 바탕으로 스피치 연습용 찬반 토론 주제를 한국어 1문장으로 만들어주세요.\n\n뉴스:\n${articleText}\n\n${TOPIC_RULES}`;
  } else if (mode === 'term') {
    prompt = `AI 용어 "${term}"을 주제로 스피치 연습용 찬반 토론 주제를 한국어 1문장으로 만들어주세요.\n\n${TOPIC_RULES}`;
  } else if (mode === 'custom' && summary) {
    prompt = `다음 내용을 바탕으로 스피치 연습용 찬반 토론 주제를 한국어 1문장으로 만들어주세요.\n\n내용:\n${summary}\n\n${TOPIC_RULES}`;
  } else {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
    let topic = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (topic && !topic.endsWith('?')) topic += '?';
    res.status(200).json({ topic });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
