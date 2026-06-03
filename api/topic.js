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

  try {
    // ── 뉴스 모드: 최적 기사 선정 + 3문장 구조 주제 ──
    if (mode === 'news' && articles?.length > 0) {
      const articleList = articles
        .map((a, i) => `${i + 1}. 제목: ${a.title}\n   요약: ${a.summary || a.description || '(없음)'}`)
        .join('\n\n');

      const prompt = `당신은 스피치 코치입니다. 아래 AI 관련 뉴스 기사 목록에서 찬반 토론에 가장 적합한 기사 1개를 선정하고, 스피치 연습 주제를 만드세요.

기사 목록:
${articleList}

아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "selectedArticle": "선정한 기사 제목 (원문 그대로)",
  "question": "핵심 찬반 질문 (반드시 ?로 끝나기, 예: 'AI 규제는 혁신을 막는가?')",
  "background": "선정 기사의 핵심 배경 설명 한 문장 (~다. 형태로 끝나기)",
  "discussion": "추가 토론 포인트 질문 (반드시 ?로 끝나기)"
}`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 600,
              responseMimeType: 'application/json'
            }
          })
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || `Gemini API 오류: ${response.status}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const result = JSON.parse(rawText);

      const ensureQ = (s) => { const t = (s || '').trim(); return t && !t.endsWith('?') ? t + '?' : t; };

      const topic = [
        ensureQ(result.question),
        (result.background || '').trim(),
        ensureQ(result.discussion)
      ].filter(Boolean).join('\n');

      return res.status(200).json({
        topic,
        selectedArticle: (result.selectedArticle || '').trim()
      });
    }

    // ── 용어 / 자료 모드: 단일 질문형 문장 ──
    const TOPIC_RULES = `출력 규칙 (반드시 준수):
- 한국어 질문형 완전한 문장 1개만 출력
- 반드시 물음표(?)로 끝낼 것 — 절대 예외 없음
- 찬반 토론 또는 의견 제시가 가능한 주제
- 예시: "AI 규제는 혁신을 막는가?", "챗GPT는 교육 현장을 바꿀 수 있는가?", "AI는 인간의 일자리를 대체할 것인가?"
- 번호, 따옴표, 부가 설명 없이 문장만 출력`;

    let prompt = '';
    if (mode === 'term') {
      prompt = `AI 용어 "${term}"을 주제로 스피치 연습용 찬반 토론 주제를 한국어 1문장으로 만들어주세요.\n\n${TOPIC_RULES}`;
    } else if (mode === 'custom' && summary) {
      prompt = `다음 내용을 바탕으로 스피치 연습용 찬반 토론 주제를 한국어 1문장으로 만들어주세요.\n\n내용:\n${summary}\n\n${TOPIC_RULES}`;
    } else {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }

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
