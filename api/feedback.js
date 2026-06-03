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

  const { audioBase64, audioMimeType, topic, transcript } = req.body;
  if (!audioBase64 && !transcript) {
    return res.status(400).json({ error: '오디오 또는 텍스트가 필요합니다.' });
  }

  const evalInstruction = `주제: ${topic || '자유 주제'}

다음 스피치를 두 가지 관점(PREP 형식 + 내용·전달)으로 한국어 평가해주세요.

[PREP 형식 평가] 각 항목 0~10점:
- point_intro      (P - 두괄식 구조): 핵심 주장을 먼저 제시했는가?
- reason           (R - 근거 제시):   논리적 근거를 충분히 제시했는가?
- example          (E - 예시 활용):   구체적 사례·데이터를 활용했는가?
- point_conclusion (P - 결론 마무리): 핵심 주장으로 명확히 마무리했는가?

[내용 & 전달 평가] 각 항목 0~10점:
- relevance (주제 연관성): 스피치 내용이 주제와 얼마나 관련 있는가?
- logic     (논리적 타당성): 전체 논리 흐름이 타당하고 일관성 있는가?
- depth     (내용의 깊이): 내용이 충분히 심층적이고 구체적인가?
- clarity   (전달 명확성): 표현이 명확하고 청중이 이해하기 쉬운가?

total = 8개 점수 합산을 100점 기준으로 환산 (합산 최대 80점 → 100점)

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "scores": {
    "point_intro":      { "score": 7, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "reason":           { "score": 6, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "example":          { "score": 5, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "point_conclusion": { "score": 8, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "relevance":        { "score": 7, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "logic":            { "score": 6, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "depth":            { "score": 5, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "clarity":          { "score": 7, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" }
  },
  "total": 74,
  "summary": "전체 총평 2~3문장",
  "next_goal": "다음 스피치를 위한 구체적 목표 1문장"
}`;

  try {
    let parts = [];
    if (audioBase64) {
      parts = [
        { text: `아래 지시에 따라 오디오 스피치를 먼저 한국어로 전사한 뒤 평가해주세요.\n\n${evalInstruction}` },
        { inline_data: { mime_type: audioMimeType || 'audio/webm', data: audioBase64 } }
      ];
    } else {
      parts = [{ text: `${evalInstruction}\n\n스피치 텍스트:\n${transcript}` }];
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2000,
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

    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { error: 'JSON 파싱 실패' };
    }

    // total 재계산 (8개 × 최대 10점 = 80점 → 100점 환산)
    if (result.scores) {
      const keys = ['point_intro', 'reason', 'example', 'point_conclusion', 'relevance', 'logic', 'depth', 'clarity'];
      const sum = keys.reduce((acc, k) => acc + (result.scores[k]?.score || 0), 0);
      result.total = Math.round((sum / 80) * 100);
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
