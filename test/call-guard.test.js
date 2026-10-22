import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../src/config.js');
const { checkCallAllowed, registerCall, unregisterCall, getCallStats } = await import('../src/call-guard.js');

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
