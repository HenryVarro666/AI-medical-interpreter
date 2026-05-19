/**
 * Centralised config. Values come from environment (see `.env.example`).
 * Missing required keys fail fast at startup so we never reach a live call
 * in a broken state.
 */
import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '5050', 10),

  // OpenAI
  openaiApiKey: required('OPENAI_API_KEY'),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
  openaiTranslateModel: process.env.OPENAI_TRANSLATE_MODEL || '',
  openaiWhisperModel: process.env.OPENAI_WHISPER_MODEL || 'gpt-realtime-whisper',
  voice: process.env.VOICE || 'alloy',

  // Public host used by Twilio to reach our WS endpoint. Only needed if you
  // want the server to self-generate the <Stream url=""> in TwiML. By default
  // we read `req.headers.host`, which is usually correct behind ngrok.
  publicHost: process.env.PUBLIC_HOST || null,

  // Language pair for the translator prompt
  speakerALang: process.env.SPEAKER_A_LANG || 'Chinese',
  speakerBLang: process.env.SPEAKER_B_LANG || 'English',

  // Twilio (for auto-sync webhook URL)
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',

  // Voice cloning bridge (future)
  enableVoiceClone: process.env.ENABLE_VOICE_CLONE === 'true',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || null,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || null,

  // Medical dashboard & compliance
  enableDashboard: process.env.ENABLE_DASHBOARD !== 'false',
  sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES || '60', 10),
  auditLogPath: process.env.AUDIT_LOG_PATH || 'data/audit.log',
  debugLogTranscripts: process.env.DEBUG_LOG_TRANSCRIPTS === 'true',

  // Call guard / abuse prevention
  maxConcurrentCalls: parseInt(process.env.MAX_CONCURRENT_CALLS || '5', 10),
  maxCallDurationMs: parseInt(process.env.MAX_CALL_DURATION_MIN || '30', 10) * 60_000,
  maxSilenceDurationSec: parseInt(process.env.MAX_SILENCE_SEC || '60', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '10', 10) * 60_000,
  rateLimitMaxCalls: parseInt(process.env.RATE_LIMIT_MAX_CALLS || '10', 10),

  // Post-ASR transcript cleaning via GPT-4o-mini. Fixes code-switching errors.
  // Adds ~200-400ms latency to transcript display (audio is unaffected).
  enableTranscriptCleaning: process.env.ENABLE_TRANSCRIPT_CLEANING === 'true',

  // Whisper language hint for ASR (ISO 639-1). Helps with mixed-language
  // recognition by biasing toward the expected primary language.
  // 'zh' for Chinese-dominant, 'en' for English-dominant, empty for auto-detect.
  whisperLanguageHint: process.env.WHISPER_LANGUAGE_HINT || '',

  // Session mode: 'translator' (default) or 'intake'
  defaultMode: process.env.DEFAULT_MODE || 'translator',
};
