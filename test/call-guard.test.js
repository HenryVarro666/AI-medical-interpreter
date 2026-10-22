import { auditLogPath } from './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulawChunk, readAudit } from './helpers/fakes.js';

const { config } = await import('../src/config.js');
const { checkCallAllowed, registerCall, unregisterCall, getCallStats, trackAudioChunk } = await import('../src/call-guard.js');

const SILENCE = ulawChunk(0xFF);
const LOUD = ulawChunk(0x80);
const chunksFor = (seconds) => Math.round(seconds / 0.02);

function feed(callId, payload, count) {
  const actions = [];
  for (let i = 0; i < count; i++) actions.push(trackAudioChunk(callId, payload).action);
  return actions.filter(a => a !== 'continue');
}

test('per-number rate limit rejects once the caller reaches RATE_LIMIT_MAX_CALLS', () => {
  const number = '+15550000001';
  for (let i = 0; i < config.rateLimitMaxCalls; i++) {
    assert.equal(checkCallAllowed(`CA-rl-${i}`, number).allowed, true, `call ${i + 1} should be allowed`);
    registerCall(`CA-rl-${i}`, number);
    unregisterCall(`CA-rl-${i}`);
  }

  const verdict = checkCallAllowed('CA-rl-next', number);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /Too many recent calls/);

  assert.equal(checkCallAllowed('CA-rl-other', '+15550000002').allowed, true, 'other numbers are unaffected');
  assert.equal(getCallStats().activeCalls, 0);
});

test('rate limit still applies when RATE_LIMIT_MAX_CALLS is above 20', (t) => {
  const saved = config.rateLimitMaxCalls;
  config.rateLimitMaxCalls = 25;
  t.after(() => { config.rateLimitMaxCalls = saved; });

  const number = '+15550000003';
  for (let i = 0; i < 25; i++) {
    registerCall(`CA-big-${i}`, number);
    unregisterCall(`CA-big-${i}`);
  }
  assert.equal(checkCallAllowed('CA-big-next', number).allowed, false);
});

test('calls older than the window stop counting', async (t) => {
  const saved = config.rateLimitWindowMs;
  config.rateLimitWindowMs = 30;
  t.after(() => { config.rateLimitWindowMs = saved; });

  const number = '+15550000004';
  for (let i = 0; i < config.rateLimitMaxCalls; i++) {
    registerCall(`CA-win-${i}`, number);
    unregisterCall(`CA-win-${i}`);
  }
  assert.equal(checkCallAllowed('CA-win-next', number).allowed, false);

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(checkCallAllowed('CA-win-later', number).allowed, true);
});

test('max duration calls onMaxDuration once and frees the call slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = 0;
  registerCall('CA-max', '+15550000005', { onMaxDuration: () => { ended++; } });
  assert.equal(getCallStats().activeCalls, 1);

  t.mock.timers.tick(config.maxCallDurationMs - 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 0, 'not before the limit');

  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 1);
  assert.equal(getCallStats().activeCalls, 0);

  t.mock.timers.tick(config.maxCallDurationMs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 1, 'fires only once');
});

test('unregisterCall cancels the max-duration timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = 0;
  registerCall('CA-max-cancel', '+15550000006', { onMaxDuration: () => { ended++; } });
  unregisterCall('CA-max-cancel');
  t.mock.timers.tick(config.maxCallDurationMs * 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 0);
});

test('silence warning and hang-up are each reported once, not on every chunk', () => {
  const number = '+15550000007';
  registerCall('CA-silence', number);
  const actions = feed('CA-silence', SILENCE, chunksFor(config.maxSilenceDurationSec * 4));
  unregisterCall('CA-silence');

  assert.deepEqual(actions, ['warn_silence', 'hangup_silence']);
  const audit = readAudit(auditLogPath).filter(e => e.actor === number);
  assert.equal(audit.filter(e => e.action === 'call_warning').length, 1);
  assert.equal(audit.filter(e => e.reason === 'extended_silence_hangup').length, 1);
});

test('speech resets the silence timer and re-arms the warning', () => {
  registerCall('CA-silence-2', '+15550000008');
  const stretch = chunksFor(config.maxSilenceDurationSec * 1.5);
  const actions = [
    ...feed('CA-silence-2', SILENCE, stretch),
    ...feed('CA-silence-2', LOUD, 1),
    ...feed('CA-silence-2', SILENCE, stretch),
  ];
  unregisterCall('CA-silence-2');
  assert.deepEqual(actions, ['warn_silence', 'warn_silence']);
});

test('near-zero samples of either sign count as silence', () => {
  // Low-level line noise alternating around zero: +0, -0, +1, -1 in μ-law.
  const noiseFloor = Buffer.from(Array.from({ length: 160 }, (_, i) => [0xFF, 0x7F, 0xFE, 0x7E][i % 4])).toString('base64');
  registerCall('CA-noise', '+15550000009');
  const actions = feed('CA-noise', noiseFloor, chunksFor(config.maxSilenceDurationSec * 1.5));
  const loud = feed('CA-noise', ulawChunk(0x00), 1); // full-scale negative sample
  unregisterCall('CA-noise');
  assert.deepEqual(actions, ['warn_silence']);
  assert.deepEqual(loud, []);
});
