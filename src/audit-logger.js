import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

let dirEnsured = false;

export function logAudit(action, sessionId, actor = 'system', details = {}) {
  if (!dirEnsured) {
    mkdirSync(dirname(config.auditLogPath), { recursive: true });
    dirEnsured = true;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    sessionId,
    actor,
    ...details,
  };

  try {
    appendFileSync(config.auditLogPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}
