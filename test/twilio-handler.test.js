import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeTwilioSocket, FakeOpenAIClient, mockFetch, flush,
  webhookRequest, webhookResponse, streamParameters, startMessage,
  mediaMessage, ulawChunk,
} from './helpers/fakes.js';

const { config } = await import('../src/config.js');
const { handleIncomingCall, handleMediaStream } = await import('../src/twilio-handler.js');
const { getCallStats } = await import('../src/call-guard.js');
const { sessionManager } = await import('../src/session-manager.js');

const fetchMock = mockFetch();

function sessionFor(callSid) {
  return [...sessionManager.sessions.values()].find(s => s.callSid === callSid);
}

function resetTwilio(t) {
  fetchMock.calls.length = 0;
  fetchMock.twilioResponse = { status: 200, body: '{"status":"completed"}' };
  const saved = { sid: config.twilioAccountSid, token: config.twilioAuthToken };
  t.after(() => {
    config.twilioAccountSid = saved.sid;
    config.twilioAuthToken = saved.token;
  });
}

function incomingCall(from, callSid, query = {}) {
  const res = webhookResponse();
  handleIncomingCall(webhookRequest({ From: from, CallSid: callSid }, query), res);
  return res.body;
}

/** Open a media stream the way Twilio does after receiving `twiml`. */
async function openStream(twiml, callSid, clientOptions = {}) {
  const ws = new FakeTwilioSocket();
  const clients = [];
  handleMediaStream(ws, {}, {
    createOpenAIClient: (mode, model) => {
      const client = new FakeOpenAIClient(mode, model, clientOptions);
      clients.push(client);
      return client;
    },
  });
  await ws.deliver(startMessage({ callSid, customParameters: streamParameters(twiml) }));
  return { ws, openai: clients[0] };
}

test('TwiML passes the caller number to the media stream', () => {
  const twiml = incomingCall('+15551110000', 'CA-twiml', { mode: 'intake', model: 'gpt-realtime-2' });
  assert.deepEqual(streamParameters(twiml), { mode: 'intake', model: 'gpt-realtime-2', from: '+15551110000' });
});

test('request values are XML-escaped in the TwiML', () => {
  const twiml = incomingCall('+1555"/><Hangup/>', 'CA-escape', { mode: 'translator' });
  assert.ok(!twiml.includes('"/><Hangup/>'), 'raw markup from the request must not reach the TwiML');
  assert.equal(streamParameters(twiml).from, '+1555"/><Hangup/>');
});

test('per-number rate limit applies to real calls (webhook -> media stream -> next webhook)', async () => {
  const number = '+15552220000';
  for (let i = 0; i < config.rateLimitMaxCalls; i++) {
    const twiml = incomingCall(number, `CA-rate-${i}`);
    assert.match(twiml, /<Connect>/, `call ${i + 1} should be connected`);
    const { ws } = await openStream(twiml, `CA-rate-${i}`);
    await ws.deliver({ event: 'stop' });
  }

  const rejected = incomingCall(number, 'CA-rate-over');
  assert.match(rejected, /Too many recent calls/);
  assert.match(rejected, /<Hangup\/>/);
  assert.doesNotMatch(rejected, /<Connect>/);

  assert.match(incomingCall('+15553330000', 'CA-rate-other'), /<Connect>/, 'other numbers are unaffected');
  assert.equal(getCallStats().activeCalls, 0);
  assert.equal(fetchMock.twilioCalls.length, 0, 'normal hang-ups need no REST call');
});

test('TwiML hangs up once the media stream is closed by the server', () => {
  const twiml = incomingCall('+15554440000', 'CA-hangup-verb');
  assert.match(twiml, /<\/Connect>\s*<Hangup\/>\s*<\/Response>/);
});

test('max duration completes the call via the Twilio REST API and closes stream and OpenAI', async (t) => {
  resetTwilio(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ws, openai } = await openStream(incomingCall('+15555550000', 'CA-max-1'), 'CA-max-1');
  assert.equal(getCallStats().activeCalls, 1);

  t.mock.timers.tick(config.maxCallDurationMs);
  await flush();
  await flush();

  assert.equal(fetchMock.twilioCalls.length, 1);
  const [{ url, init }] = fetchMock.twilioCalls;
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls/CA-max-1.json');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, 'Status=completed');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('ACtest:test-token').toString('base64')}`);

  assert.equal(openai.closed, true, 'OpenAI session closed');
  assert.equal(ws.readyState, ws.CLOSED, 'media stream closed');
  assert.deepEqual(ws.closeCalls[0], { code: 1000, reason: 'max_duration' });
  assert.equal(getCallStats().activeCalls, 0);

  const session = sessionFor('CA-max-1');
  assert.notEqual(session.status, 'active');
  assert.ok(session.transcripts.some(e => e.role === 'system' && /maximum call duration/.test(e.text)));

  // Twilio then reports the stop; that must not trigger a second hang-up.
  await ws.deliver({ event: 'stop' });
  assert.equal(fetchMock.twilioCalls.length, 1);
});

test('max duration without Twilio credentials still closes the stream and OpenAI', async (t) => {
  resetTwilio(t);
  config.twilioAccountSid = '';
  config.twilioAuthToken = '';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ws, openai } = await openStream(incomingCall('+15555550001', 'CA-max-2'), 'CA-max-2');

  t.mock.timers.tick(config.maxCallDurationMs);
  await flush();
  await flush();

  assert.equal(fetchMock.twilioCalls.length, 0, 'no REST request without credentials');
  assert.equal(openai.closed, true);
  assert.equal(ws.readyState, ws.CLOSED);
  assert.equal(getCallStats().activeCalls, 0);
});

test('a failed REST hang-up still closes the stream and OpenAI', async (t) => {
  resetTwilio(t);
  fetchMock.twilioResponse = { status: 401, body: '{"message":"Authenticate"}' };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ws, openai } = await openStream(incomingCall('+15555550002', 'CA-max-3'), 'CA-max-3');

  t.mock.timers.tick(config.maxCallDurationMs);
  await flush();
  await flush();

  assert.equal(fetchMock.twilioCalls.length, 1);
  assert.equal(openai.closed, true);
  assert.equal(ws.readyState, ws.CLOSED);
});

test('extended silence ends the call once, the same way as max duration', async (t) => {
  resetTwilio(t);
  const { ws, openai } = await openStream(incomingCall('+15556660000', 'CA-silent'), 'CA-silent');

  const hangupAfter = Math.round((config.maxSilenceDurationSec * 2) / 0.02) + 1;
  for (let i = 0; i < hangupAfter + 50; i++) await ws.deliver(mediaMessage(ulawChunk(0xFF)));
  await flush();

  assert.equal(fetchMock.twilioCalls.length, 1, 'one REST hang-up, not one per chunk');
  assert.equal(fetchMock.twilioCalls[0].init.body, 'Status=completed');
  assert.equal(openai.closed, true);
  assert.equal(ws.readyState, ws.CLOSED);
  assert.deepEqual(ws.closeCalls[0], { code: 1000, reason: 'extended_silence' });
  assert.equal(getCallStats().activeCalls, 0);
  assert.ok(openai.audio.length < hangupAfter, 'no audio forwarded after the hang-up');

  const system = sessionFor('CA-silent').transcripts.filter(e => e.role === 'system').map(e => e.text);
  assert.deepEqual(system, [
    '[Extended silence detected — no speech received]',
    '[Call ended due to extended silence]',
  ]);
});
