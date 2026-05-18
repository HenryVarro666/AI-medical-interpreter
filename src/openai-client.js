/**
 * Thin wrapper around the OpenAI Realtime API WebSocket.
 *
 * Lifecycle:
 *   new OpenAIRealtimeClient()
 *      -> connect()          // opens WS + sends session.update
 *      -> sendAudio(b64)     // push μ-law audio from Twilio
 *      -> on('audio', ...)   // receive μ-law audio to send BACK to Twilio
 *      -> on('speech_started', ...)  // barge-in: user started talking again
 *      -> close()
 *
 * Events we care about from OpenAI:
 *   session.created / session.updated          — handshake ok
 *   input_audio_buffer.speech_started          — server VAD detected speech
 *   input_audio_buffer.speech_stopped          — VAD detected end of turn
 *   response.audio.delta                       — base64 μ-law chunk of TTS
 *   response.audio_transcript.done             — full text of what we spoke
 *   conversation.item.input_audio_transcription.completed
 *                                              — what the user said (debug)
 *   error                                      — anything went wrong
 *
 * Docs: https://platform.openai.com/docs/guides/realtime
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';

import { config } from './config.js';
import { TRANSLATOR_INSTRUCTIONS } from './prompts.js';
import { INTAKE_INSTRUCTIONS } from './intake-prompts.js';

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openaiModel)}`;

export class OpenAIRealtimeClient extends EventEmitter {
  constructor(mode = 'translator') {
    super();
    this.ws = null;
    this.ready = false;
    this.mode = mode;

    // Echo suppression: while the AI is actively speaking, incoming audio
    // is almost always our own TTS bleeding back through the caller's mic
    // (common on phones without echo cancellation). Dropping those chunks
    // prevents the AI from "hearing itself" and interrupting its own output.
    this.aiSpeaking = false;
    this._aiSpeakingReleaseTimer = null;
  }

  _markAiSpeaking() {
    this.aiSpeaking = true;
    if (this._aiSpeakingReleaseTimer) {
      clearTimeout(this._aiSpeakingReleaseTimer);
      this._aiSpeakingReleaseTimer = null;
    }
  }

  _markAiDoneSpeaking() {
    // Hold the gate open for a short tail to catch trailing echo after
    // the AI's last audio chunk has finished playing through the phone.
    if (this._aiSpeakingReleaseTimer) clearTimeout(this._aiSpeakingReleaseTimer);
    this._aiSpeakingReleaseTimer = setTimeout(() => {
      this.aiSpeaking = false;
      this._aiSpeakingReleaseTimer = null;
    }, 800);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.once('open', () => {
        console.log('[openai] WS connected');
        this._configureSession();
        resolve();
      });

      this.ws.on('message', (data) => this._handleEvent(data));

      this.ws.on('error', (err) => {
        console.error('[openai] WS error', err?.message || err);
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[openai] WS closed ${code} ${reason?.toString() || ''}`);
        this.ready = false;
        this.emit('close');
      });
    });
  }

  _configureSession() {
    const isIntake = this.mode === 'intake';

    this._send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: isIntake ? INTAKE_INSTRUCTIONS : TRANSLATOR_INSTRUCTIONS,
        voice: config.voice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1',
          language: config.whisperLanguageHint || undefined,
        },
        turn_detection: {
          type: 'server_vad',
          threshold: isIntake ? 0.5 : 0.65,
          prefix_padding_ms: 300,
          silence_duration_ms: isIntake ? 1200 : 700,
        },
        temperature: isIntake ? 0.7 : 0.6,
      },
    });
    this.ready = true;
    console.log(`[openai] session configured in ${this.mode} mode`);
  }

  _handleEvent(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[openai] ${event.type}`);
        break;

      case 'response.created':
      case 'response.output_item.added':
        // AI is about to / just started speaking. Open the echo gate.
        this._markAiSpeaking();
        break;

      case 'input_audio_buffer.speech_started':
        // We intentionally no longer emit 'speech_started' for a barge-in
        // clear, because on phones without echo cancellation this event
        // fires on the AI hearing itself. The echo gate below (sendAudio)
        // prevents that inbound audio from ever reaching the server during
        // AI speech, but keep this comment as a reminder.
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;

      case 'response.audio.delta':
        this._markAiSpeaking();
        this.emit('audio', event.delta);
        break;

      case 'response.audio_transcript.delta':
        this.emit('transcript_delta', { role: 'translation', delta: event.delta });
        break;

      case 'response.audio_transcript.done':
        if (config.debugLogTranscripts) {
          console.log(`[openai] translated: ${event.transcript}`);
        }
        this.emit('transcript', { role: 'translation', text: event.transcript });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (config.debugLogTranscripts) {
          console.log(`[openai] heard:      ${event.transcript}`);
        }
        this.emit('transcript', { role: 'caller', text: event.transcript });
        break;

      case 'response.audio.done':
      case 'response.done':
        // Start the trailing-echo release timer.
        this._markAiDoneSpeaking();
        break;

      case 'error':
        console.error('[openai] error event:', event.error);
        this.emit('error', event.error);
        break;

      default:
        // Dozens of other event types exist; ignore unless we need them.
        break;
    }
  }

  sendAudio(audioBase64) {
    // Echo gate: drop inbound audio while the AI is speaking. The caller's
    // phone mic almost always picks up our own TTS, and OpenAI's VAD would
    // otherwise treat it as a new user turn, truncating the translation.
    if (this.aiSpeaking) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    });
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  isReady() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
    this.ready = false;
  }
}
