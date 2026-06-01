/**
 * ai.js — Gemini-powered spending insights
 */

const GEMINI_API_KEY = 'AIzaSyARGy81Vm4HZzrI6Jka3MMu0S2Mxx5Guqw';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function fetchAIInsights(prompt) {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `API error (${res.status})`;
    throw new Error(msg);
  }

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('No insight returned from AI');

  if (candidate?.finishReason === 'MAX_TOKENS') {
    return text + '\n\n(Note: response was cut off by length limit — click Analyze again if needed.)';
  }
  return text;
}
