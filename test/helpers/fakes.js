import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';

/** Stand-in for the Twilio Media Streams WebSocket handed to handleMediaStream(). */
export class FakeTwilioSocket extends EventEmitter {
  OPEN = 1;
  CLOSED = 3;
  readyState = 1;
  sent = [];
  closeCalls = [];

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit('close', code, reason);
  }

  /** Deliver a Twilio message to the server and let its async handler run. */
  async deliver(msg) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
    await flush();
  }
}

/** Stand-in for OpenAIRealtimeClient: no network, records what it is sent. */
export class FakeOpenAIClient extends EventEmitter {
  constructor(mode, model, { connectError = null } = {}) {
    super();
    this.mode = mode;
    this.model = model;
    this.connectError = connectError;
    this.ready = false;
    this.closed = false;
    this.audio = [];
  }

  async connect() {
    if (this.connectError) throw this.connectError;
    this.ready = true;
  }

  isReady() {
    return this.ready && !this.closed;
  }

  sendAudio(payload) {
    this.audio.push(payload);
  }

  close() {
    this.closed = true;
    this.ready = false;
  }
}

/**
 * Replace globalThis.fetch. Twilio REST calls get `twilioResponse` (default 200);
 * anything else (e.g. the SOAP-note request at session end) gets a 500 so it
 * fails fast without network access.
 */
export function mockFetch() {
  const original = globalThis.fetch;
  const state = {
    calls: [],
    twilioResponse: { status: 200, body: '{"status":"completed"}' },
    get twilioCalls() {
      return this.calls.filter(c => c.url.startsWith('https://api.twilio.com/'));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    state.calls.push({ url, init });
    const { status, body } = url.startsWith('https://api.twilio.com/')
      ? state.twilioResponse
      : { status: 500, body: 'no network in tests' };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return state;
}

export function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

/** Minimal Express-like request/response pair for handleIncomingCall(). */
export function webhookRequest(body = {}, query = {}) {
  return { body, query, headers: { host: 'interpreter.example.test' } };
}

export function webhookResponse() {
  return {
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

/** The <Parameter> values of a TwiML <Stream>, as Twilio puts them in start.customParameters. */
export function streamParameters(twiml) {
  const params = {};
  for (const [, name, value] of twiml.matchAll(/<Parameter name="([^"]*)" value="([^"]*)"/g)) {
    params[name] = value
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return params;
}

export function startMessage({ callSid, streamSid = `MZ${callSid}`, customParameters = {} }) {
  return { event: 'start', start: { streamSid, callSid, customParameters } };
}

export function mediaMessage(payload) {
  return { event: 'media', media: { payload } };
}

/** 20 ms of μ-law audio filled with one byte value (0xFF is digital silence). */
export function ulawChunk(byte) {
  return Buffer.alloc(160, byte).toString('base64');
}

export function readAudit(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
