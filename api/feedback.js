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

다음 스피치를 PREP 프레임워크 기반으로 한국어로 평가해주세요.

PREP 평가 기준 (각 항목 0~10점):
- point_intro   (P - 핵심 먼저):   처음에 핵심 주장/결론을 명확히 제시했는가?
- reason        (R - 논리적 근거): 주장을 뒷받침하는 논리적 이유를 제시했는가?
- example       (E - 구체적 예시): 근거를 뒷받침하는 사례·데이터·경험을 들었는가?
- point_conclusion (P - 명확한 결론): 핵심 주장을 다시 강조하며 마무리했는가?
- clarity       (전달 명확성):     전체적으로 표현이 명확하고 논리 흐름이 있는가?

total = 5개 점수 합산 × 2 (0~100점 환산)

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "scores": {
    "point_intro":      { "score": 7, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "reason":           { "score": 6, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "example":          { "score": 5, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "point_conclusion": { "score": 8, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" },
    "clarity":          { "score": 7, "good": "잘한 점 한 문장", "improve": "개선할 점 한 문장" }
  },
  "total": 66,
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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

    // total 검증 및 재계산
    if (result.scores) {
      const keys = ['point_intro', 'reason', 'example', 'point_conclusion', 'clarity'];
      const sum = keys.reduce((acc, k) => acc + (result.scores[k]?.score || 0), 0);
      result.total = Math.round(sum * 2);
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
