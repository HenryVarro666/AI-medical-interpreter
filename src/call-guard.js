import { config } from './config.js';
import { logAudit } from './audit-logger.js';

const activeCalls = new Map();
const callHistory = new Map();

export function checkCallAllowed(callSid, callerNumber) {
  if (activeCalls.size >= config.maxConcurrentCalls) {
    logAudit('call_rejected', null, callerNumber, { reason: 'max_concurrent_calls' });
    return { allowed: false, reason: 'System is at capacity. Please try again later.' };
  }

  const history = callHistory.get(callerNumber) || [];
  const recentWindow = Date.now() - config.rateLimitWindowMs;
  const recentCalls = history.filter(t => t > recentWindow);
  if (recentCalls.length >= config.rateLimitMaxCalls) {
    logAudit('call_rejected', null, callerNumber, { reason: 'rate_limited' });
    return { allowed: false, reason: 'Too many recent calls. Please wait and try again.' };
  }

  return { allowed: true };
}

export function registerCall(callSid, callerNumber) {
  const timer = setTimeout(() => {
    forceEndCall(callSid);
  }, config.maxCallDurationMs);

  activeCalls.set(callSid, {
    callerNumber,
    startedAt: Date.now(),
    timer,
    silentChunks: 0,
    totalChunks: 0,
  });

  const history = callHistory.get(callerNumber) || [];
  history.push(Date.now());
  callHistory.set(callerNumber, history.slice(-20));
}

export function unregisterCall(callSid) {
  const entry = activeCalls.get(callSid);
  if (entry) {
    clearTimeout(entry.timer);
    activeCalls.delete(callSid);
  }
}

export function trackAudioChunk(callSid, payload) {
  const entry = activeCalls.get(callSid);
  if (!entry) return { action: 'continue' };

  entry.totalChunks++;

  const isSilent = isChunkSilent(payload);
  if (isSilent) {
    entry.silentChunks++;
  } else {
    entry.silentChunks = 0;
  }

  const silentSeconds = entry.silentChunks * 0.02;
  if (silentSeconds > config.maxSilenceDurationSec) {
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
  if (entry) {
    logAudit('call_force_ended', null, entry.callerNumber, {
      reason: 'max_duration',
      durationMs: Date.now() - entry.startedAt,
    });
    unregisterCall(callSid);
  }
}

export function getCallStats() {
  return {
    activeCalls: activeCalls.size,
    maxConcurrent: config.maxConcurrentCalls,
  };
}
