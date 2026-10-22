import { config } from './config.js';
import { logAudit } from './audit-logger.js';

const activeCalls = new Map();
// callerNumber -> start times of that number's calls inside the rate-limit window
const callHistory = new Map();

function recentCallTimes(callerNumber, now = Date.now()) {
  const cutoff = now - config.rateLimitWindowMs;
  const recent = (callHistory.get(callerNumber) || []).filter(t => t > cutoff);
  if (recent.length > 0) callHistory.set(callerNumber, recent);
  else callHistory.delete(callerNumber);
  return recent;
}

export function checkCallAllowed(callSid, callerNumber) {
  if (activeCalls.size >= config.maxConcurrentCalls) {
    logAudit('call_rejected', null, callerNumber, { reason: 'max_concurrent_calls' });
    return { allowed: false, reason: 'System is at capacity. Please try again later.' };
  }

  if (recentCallTimes(callerNumber).length >= config.rateLimitMaxCalls) {
    logAudit('call_rejected', null, callerNumber, { reason: 'rate_limited' });
    return { allowed: false, reason: 'Too many recent calls. Please wait and try again.' };
  }

  return { allowed: true };
}

/**
 * Track a call whose media stream has started and count it against the
 * caller's rate limit.
 * @param {string} callSid  Twilio CallSid (StreamSid if Twilio sent none)
 * @param {string} callerNumber  Twilio `From`, passed to the media stream as
 *   the `from` <Parameter>; must match what checkCallAllowed() was given
 * @param {{ onMaxDuration?: () => void | Promise<void> }} [hooks]
 *   onMaxDuration is called once MAX_CALL_DURATION_MIN has passed; it must
 *   actually end the call (call-guard only tracks it).
 */
export function registerCall(callSid, callerNumber, { onMaxDuration } = {}) {
  const now = Date.now();
  const timer = setTimeout(() => {
    forceEndCall(callSid);
  }, config.maxCallDurationMs);

  activeCalls.set(callSid, {
    callerNumber,
    startedAt: now,
    timer,
    onMaxDuration,
    silentChunks: 0,
    totalChunks: 0,
    silenceWarned: false,
    silenceHangup: false,
  });

  // Keep only calls inside the window; the newest rateLimitMaxCalls of them
  // are all the check needs (a fixed cap here would hide larger limits).
  const history = recentCallTimes(callerNumber, now);
  history.push(now);
  callHistory.set(callerNumber, history.slice(-Math.max(config.rateLimitMaxCalls, 1)));
}

export function unregisterCall(callSid) {
  const entry = activeCalls.get(callSid);
  if (entry) {
    clearTimeout(entry.timer);
    activeCalls.delete(callSid);
  }
}

/**
 * Feed one inbound 20 ms media chunk. Returns 'warn_silence' once per silent
 * stretch longer than MAX_SILENCE_SEC, and 'hangup_silence' once when it
 * passes 2 x MAX_SILENCE_SEC (the caller must then end the call); otherwise
 * 'continue'. Each is audit-logged once, not on every chunk.
 */
export function trackAudioChunk(callSid, payload) {
  const entry = activeCalls.get(callSid);
  if (!entry || entry.silenceHangup) return { action: 'continue' };

  entry.totalChunks++;

  const isSilent = isChunkSilent(payload);
  if (isSilent) {
    entry.silentChunks++;
  } else {
    entry.silentChunks = 0;
    entry.silenceWarned = false;
  }

  const silentSeconds = entry.silentChunks * 0.02;
  if (silentSeconds > config.maxSilenceDurationSec * 2) {
    entry.silenceHangup = true;
    logAudit('call_force_ended', null, entry.callerNumber, { reason: 'extended_silence_hangup' });
    return { action: 'hangup_silence' };
  }
  if (silentSeconds > config.maxSilenceDurationSec && !entry.silenceWarned) {
    entry.silenceWarned = true;
    logAudit('call_warning', null, entry.callerNumber, { reason: 'extended_silence' });
    return { action: 'warn_silence' };
  }

  return { action: 'continue' };
}

function isChunkSilent(base64Payload) {
  const buf = Buffer.from(base64Payload, 'base64');
  let energy = 0;
  for (let i = 0; i < buf.length; i++) {
    const sample = buf[i];
    const deviation = Math.abs(sample - 0xFF);
    energy += deviation;
  }
  return (energy / buf.length) < 3;
}

function forceEndCall(callSid) {
  const entry = activeCalls.get(callSid);
  if (!entry) return;

  logAudit('call_force_ended', null, entry.callerNumber, {
    reason: 'max_duration',
    durationMs: Date.now() - entry.startedAt,
  });
  unregisterCall(callSid);

  if (!entry.onMaxDuration) {
    console.warn(`[call-guard] ${callSid} reached max duration but has no handler to end it`);
    return;
  }
  Promise.resolve()
    .then(() => entry.onMaxDuration())
    .catch(err => console.error(`[call-guard] ending ${callSid} failed:`, err?.message || err));
}

export function getCallStats() {
  return {
    activeCalls: activeCalls.size,
    maxConcurrent: config.maxConcurrentCalls,
  };
}
