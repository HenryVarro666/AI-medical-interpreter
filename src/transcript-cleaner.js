import { config } from './config.js';

const CLEANUP_PROMPT = `You are a transcript correction specialist for medical interpretation calls.
You receive a raw ASR transcript that may contain code-switching errors from a ${config.speakerALang}/${config.speakerBLang} bilingual speaker.

Common ASR errors in code-switched speech:
- Chinese words romanized as English (e.g., "nee how" instead of "你好")
- English medical terms misheard as Chinese characters
- Drug names garbled across language boundaries
- Numbers/dosages split incorrectly between languages

Your job: return the CORRECTED transcript preserving the original mixed-language content exactly as the speaker intended. Do NOT translate — just fix ASR errors.

Rules:
1. Keep the original language mix — do not translate Chinese to English or vice versa
2. Fix obvious ASR errors using medical context (e.g., "I book profen" → "ibuprofen")
3. If uncertain, keep the original text
4. Return ONLY the corrected text, nothing else`;

export async function cleanTranscript(rawText, recentContext = []) {
  if (!config.enableTranscriptCleaning) return rawText;
  if (rawText.length < 5) return rawText;

  const contextStr = recentContext.length > 0
    ? `\nRecent conversation context:\n${recentContext.slice(-5).map(t => `${t.role}: ${t.text}`).join('\n')}\n`
    : '';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 500,
        messages: [
          { role: 'system', content: CLEANUP_PROMPT },
          { role: 'user', content: `${contextStr}Raw transcript to correct:\n"${rawText}"` },
        ],
      }),
    });

    if (!response.ok) return rawText;

    const result = await response.json();
    const cleaned = result.choices?.[0]?.message?.content?.trim();

    if (!cleaned || cleaned.length < 2) return rawText;

    const cleanedNormalized = cleaned.replace(/^["']|["']$/g, '');
    return cleanedNormalized;
  } catch {
    return rawText;
  }
}
