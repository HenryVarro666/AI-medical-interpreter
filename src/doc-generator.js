import { config } from './config.js';
import { MEDICAL_DOC_SYSTEM_PROMPT, buildUserPrompt } from './medical-prompts.js';

export async function generateMedicalDocument(session) {
  const transcript = session.transcripts;
  if (!transcript.length) return null;

  const callDuration = session.endedAt && session.startedAt
    ? Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 1000)
    : 0;

  console.log(`[doc-gen] generating SOAP note from ${transcript.length} entries...`);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0.3,
      messages: [
        { role: 'system', content: MEDICAL_DOC_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(transcript, session.languagePair, callDuration, session.mode) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  return JSON.parse(content);
}
