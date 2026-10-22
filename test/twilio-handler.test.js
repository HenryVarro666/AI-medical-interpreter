import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeTwilioSocket, FakeOpenAIClient, mockFetch,
  webhookRequest, webhookResponse, streamParameters, startMessage,
} from './helpers/fakes.js';

const { config } = await import('../src/config.js');
const { handleIncomingCall, handleMediaStream } = await import('../src/twilio-handler.js');
const { getCallStats } = await import('../src/call-guard.js');

const fetchMock = mockFetch();

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
