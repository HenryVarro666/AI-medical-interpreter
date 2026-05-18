/**
 * TTS bridge — placeholder for future voice cloning.
 *
 * The MVP uses OpenAI Realtime's built-in voices (alloy / echo / etc.).
 * To swap in a cloned voice you have two options:
 *
 *   A) Text → clone-TTS → audio      (easiest, higher quality, +latency)
 *      Disable OpenAI's audio output, subscribe to `response.text.delta`,
 *      stream the text into ElevenLabs Streaming TTS with your cloned
 *      voice_id, resample the returned PCM to μ-law 8 kHz, forward to Twilio.
 *
 *   B) Audio → voice-convert → audio (voice-conversion model on OpenAI audio)
 *      Keep OpenAI audio output, pipe it through a realtime voice-conversion
 *      model (e.g. RVC, so-vits, or ElevenLabs Voice Changer). Lowest edit
 *      distance from the MVP but an extra hop.
 *
 * See docs/voice-cloning.md for the recommended approach.
 *
 * This file defines the interface so the rest of the code doesn't have to
 * care which path you pick.
 */
import { config } from './config.js';

/**
 * @typedef {Object} TTSBridge
 * @property {(text: string) => Promise<void>} speakText
 *   Stream text through the cloned TTS. Emits 'audio' events with base64
 *   μ-law chunks ready to send to Twilio.
 * @property {() => void} close
 */

/**
 * Factory. Returns null when voice cloning is disabled so callers can check
 * `if (bridge) { ... }` and otherwise fall back to OpenAI's built-in voice.
 *
 * @returns {TTSBridge | null}
 */
export function createTTSBridge() {
  if (!config.enableVoiceClone) return null;

  if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) {
    console.warn('[tts-bridge] ENABLE_VOICE_CLONE=true but ElevenLabs creds are missing; disabling.');
    return null;
  }

  // TODO: implement ElevenLabs streaming bridge.
  // Suggested shape:
  //   1. Open a POST stream to:
  //      https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?output_format=ulaw_8000
  //      (or use their realtime WS endpoint when it's GA)
  //   2. Push text fragments as they arrive from OpenAI's `response.text.delta`.
  //   3. Read the μ-law 8 kHz stream back, chunk it, base64-encode, emit 'audio'.
  //
  // Until implemented, throw so misconfiguration is obvious.
  throw new Error('Voice-cloning bridge not implemented yet. See docs/voice-cloning.md');
}
