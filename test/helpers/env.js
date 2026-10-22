// Import this before any src/ module.
//
// config.js reads process.env (and a .env in the cwd) once at import time, and
// the session manager reads and writes data/ relative to the cwd. Each test file
// therefore runs in its own temp directory with fixed settings, so tests never
// pick up a real .env, touch real session data or reach the network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const workDir = mkdtempSync(join(tmpdir(), 'ami-test-'));
process.chdir(workDir);

export const auditLogPath = join(workDir, 'audit.log');

Object.assign(process.env, {
  OPENAI_API_KEY: 'sk-test',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'test-token',
  TWILIO_PHONE_NUMBER: '',
  PUBLIC_HOST: 'interpreter.example.test',
  AUDIT_LOG_PATH: auditLogPath,
  MAX_CONCURRENT_CALLS: '100',
  MAX_CALL_DURATION_MIN: '30',
  MAX_SILENCE_SEC: '1',
  RATE_LIMIT_WINDOW_MIN: '10',
  RATE_LIMIT_MAX_CALLS: '3',
  ENABLE_TRANSCRIPT_CLEANING: 'false',
  DEBUG_LOG_TRANSCRIPTS: 'false',
});
