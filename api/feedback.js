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

  try {
    let parts = [];
    const evalInstruction = `주제: ${topic || '자유 주제'}

다음 스피치를 아래 5가지 기준으로 각각 0~100점 평가하고, 한국어 피드백을 제공해주세요.

평가 기준:
1. 두괄식: 핵심 내용을 먼저 제시했는가?
2. 근거: 주장을 뒷받침하는 논리적 근거가 있는가?
3. 예시: 구체적인 예시를 들었는가?
4. 결론: 명확한 결론으로 마무리했는가?
5. 전달력: 표현이 명확하고 이해하기 쉬운가?

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "transcript": "전사 또는 입력된 스피치 텍스트",
  "scores": { "두괄식": 75, "근거": 80, "예시": 60, "결론": 85, "전달력": 70 },
  "feedback": {
    "두괄식": "구체적인 피드백",
    "근거": "구체적인 피드백",
    "예시": "구체적인 피드백",
    "결론": "구체적인 피드백",
    "전달력": "구체적인 피드백"
  },
  "overall": "종합 피드백 2~3문장"
}`;

    if (audioBase64) {
      parts = [
        { text: `위 지시에 따라 다음 오디오 스피치를 먼저 한국어로 전사한 뒤 평가해주세요.\n\n${evalInstruction}` },
        { inline_data: { mime_type: audioMimeType || 'audio/webm', data: audioBase64 } }
      ];
    } else {
      parts = [
        { text: `${evalInstruction}\n\n스피치 텍스트:\n${transcript}` }
      ];
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
      result = match ? JSON.parse(match[0]) : { error: 'JSON 파싱 실패', raw: rawText };
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
