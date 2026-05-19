import WebSocket from 'ws';
import { EventEmitter } from 'events';

import { config } from './config.js';
import { TRANSLATOR_INSTRUCTIONS } from './prompts.js';
import { INTAKE_INSTRUCTIONS } from './intake-prompts.js';

const AVAILABLE_MODELS = {
  'gpt-4o-realtime':          'gpt-4o-realtime-preview-2024-12-17',
  'gpt-realtime':             'gpt-realtime',
  'gpt-realtime-2':           'gpt-realtime-2',
  'gpt-realtime-translate':   'gpt-realtime-translate',
  'gpt-realtime-whisper':     'gpt-realtime-whisper',
};

const LANG_CODES = {
  'chinese': 'zh', 'english': 'en', 'spanish': 'es', 'french': 'fr',
  'german': 'de', 'japanese': 'ja', 'korean': 'ko', 'portuguese': 'pt',
  'russian': 'ru', 'italian': 'it', 'hindi': 'hi', 'indonesian': 'id',
  'vietnamese': 'vi',
};

function resolveModel(mode, modelOverride) {
  if (modelOverride) return AVAILABLE_MODELS[modelOverride] || modelOverride;
  if (mode === 'translator' && config.openaiTranslateModel) return config.openaiTranslateModel;
  return config.openaiModel;
}

function isTranslateModel(model) {
  return model.includes('translate');
}

function isWhisperModel(model) {
  return model.includes('whisper');
}

function buildEndpoint(model) {
  if (isTranslateModel(model)) {
    return `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`;
  }
  if (isWhisperModel(model)) {
    return `wss://api.openai.com/v1/realtime/transcriptions?model=${encodeURIComponent(model)}`;
  }
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function langCode(langName) {
  return LANG_CODES[langName.toLowerCase()] || langName.toLowerCase().slice(0, 2);
}

export function getAvailableModels() {
  return Object.keys(AVAILABLE_MODELS);
}

export class OpenAIRealtimeClient extends EventEmitter {
  constructor(mode = 'translator', modelOverride = null) {
    super();
    this.ws = null;
    this.ready = false;
    this.mode = mode;
    this.model = resolveModel(mode, modelOverride);
    this.isTranslate = isTranslateModel(this.model);
    this.isWhisper = isWhisperModel(this.model);

    this.aiSpeaking = false;
    this._aiSpeakingReleaseTimer = null;
  }

  _markAiSpeaking() {
    if (this.isTranslate) return;
    this.aiSpeaking = true;
    if (this._aiSpeakingReleaseTimer) {
      clearTimeout(this._aiSpeakingReleaseTimer);
      this._aiSpeakingReleaseTimer = null;
    }
  }

  _markAiDoneSpeaking() {
    if (this._aiSpeakingReleaseTimer) clearTimeout(this._aiSpeakingReleaseTimer);
    this._aiSpeakingReleaseTimer = setTimeout(() => {
      this.aiSpeaking = false;
      this._aiSpeakingReleaseTimer = null;
    }, 800);
  }

  connect() {
    const url = buildEndpoint(this.model);
    console.log(`[openai] connecting: ${this.model} (${this.isTranslate ? 'translate' : this.isWhisper ? 'whisper' : 'conversation'})`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
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
    if (this.isTranslate) {
      this._configureTranslateSession();
    } else if (this.isWhisper) {
      this._configureWhisperSession();
    } else {
      this._configureConversationSession();
    }
    this.ready = true;
    console.log(`[openai] session configured: model=${this.model} mode=${this.mode}`);
  }

  _configureTranslateSession() {
    const outputLang = langCode(config.speakerBLang);
    this._send({
      type: 'session.update',
      session: {
        audio: {
          input: {
            noise_reduction: { type: 'near_field' },
            transcription: { model: 'gpt-realtime-whisper' },
          },
          output: {
            language: outputLang,
          },
        },
      },
    });
    console.log(`[openai] translate mode: auto-detect → ${outputLang}`);
  }

  _configureWhisperSession() {
    this._send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: 'gpt-realtime-whisper',
              language: config.whisperLanguageHint || undefined,
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
            },
          },
        },
      },
    });
  }

  _configureConversationSession() {
    const isIntake = this.mode === 'intake';
    const sessionConfig = {
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
    };

    if (this.model.includes('gpt-realtime-2')) {
      sessionConfig.reasoning = { effort: 'low' };
    }

    this._send({ type: 'session.update', session: sessionConfig });
  }

  _handleEvent(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (this.isTranslate) {
      this._handleTranslateEvent(event);
    } else if (this.isWhisper) {
      this._handleWhisperEvent(event);
    } else {
      this._handleConversationEvent(event);
    }
  }

  _handleTranslateEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[openai] ${event.type}`);
        break;

      case 'output_audio.delta':
        this.emit('audio', event.delta);
        break;

      case 'output_audio_transcript.delta':
        this.emit('transcript_delta', { role: 'translation', delta: event.delta });
        break;

      case 'output_audio_transcript.done':
        if (config.debugLogTranscripts) console.log(`[openai] translated: ${event.transcript}`);
        this.emit('transcript', { role: 'translation', text: event.transcript });
        break;

      case 'input_audio_transcript.delta':
        this.emit('transcript_delta', { role: 'caller', delta: event.delta });
        break;

      case 'input_audio_transcript.done':
        if (config.debugLogTranscripts) console.log(`[openai] heard: ${event.transcript}`);
        this.emit('transcript', { role: 'caller', text: event.transcript });
        break;

      case 'error':
        console.error('[openai] error:', event.error);
        this.emit('error', event.error);
        break;

      default:
        break;
    }
  }

  _handleWhisperEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[openai] ${event.type}`);
        break;

      case 'transcript.delta':
        this.emit('transcript_delta', { role: 'caller', delta: event.delta });
        break;

      case 'transcript.done':
        if (config.debugLogTranscripts) console.log(`[openai] transcribed: ${event.transcript}`);
        this.emit('transcript', { role: 'caller', text: event.transcript });
        break;

      case 'error':
        console.error('[openai] error:', event.error);
        this.emit('error', event.error);
        break;

      default:
        break;
    }
  }

  _handleConversationEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[openai] ${event.type}`);
        break;

      case 'response.created':
      case 'response.output_item.added':
        this._markAiSpeaking();
        break;

      case 'input_audio_buffer.speech_started':
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
        if (config.debugLogTranscripts) console.log(`[openai] translated: ${event.transcript}`);
        this.emit('transcript', { role: 'translation', text: event.transcript });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (config.debugLogTranscripts) console.log(`[openai] heard: ${event.transcript}`);
        this.emit('transcript', { role: 'caller', text: event.transcript });
        break;

      case 'response.audio.done':
      case 'response.done':
        this._markAiDoneSpeaking();
        break;

      case 'error':
        console.error('[openai] error:', event.error);
        this.emit('error', event.error);
        break;

      default:
        break;
    }
  }

  sendAudio(audioBase64) {
    if (this.aiSpeaking) return;

    if (this.isTranslate || this.isWhisper) {
      this._send({ type: 'input_audio_buffer.append', audio: audioBase64 });
    } else {
      this._send({ type: 'input_audio_buffer.append', audio: audioBase64 });
    }
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
