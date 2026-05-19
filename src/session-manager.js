import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { config } from './config.js';
import { logAudit } from './audit-logger.js';
import { generateMedicalDocument } from './doc-generator.js';

const SESSIONS_DIR = 'data/sessions';
import { cleanTranscript } from './transcript-cleaner.js';

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();

    setInterval(() => this._cleanup(), 60_000);
  }

  createSession(streamSid, callSid, mode = 'translator') {
    const id = randomUUID();
    const session = {
      id,
      streamSid,
      callSid,
      mode,
      status: 'active',
      startedAt: new Date().toISOString(),
      endedAt: null,
      languagePair: { a: config.speakerALang, b: config.speakerBLang },
      transcripts: [],
      document: null,
      dashboardClients: new Set(),
    };

    this.sessions.set(id, session);
    logAudit('session_created', id, 'system', { streamSid, callSid, mode });
    console.log(`[session] created: ${id}`);
    return session;
  }

  addTranscript(sessionId, entry) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const transcript = {
      id: session.transcripts.length + 1,
      role: entry.role,
      text: entry.text,
      timestamp: new Date().toISOString(),
    };

    session.transcripts.push(transcript);
    logAudit('transcript_received', sessionId, 'system', { role: entry.role });

    const message = JSON.stringify({ type: 'transcript', data: transcript });
    for (const client of session.dashboardClients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }

    if (entry.role === 'caller') {
      cleanTranscript(entry.text, session.transcripts).then(cleaned => {
        if (cleaned !== entry.text) {
          transcript.text = cleaned;
          transcript.rawText = entry.text;
          this._broadcast(sessionId, {
            type: 'transcript_corrected',
            data: { id: transcript.id, text: cleaned },
          });
        }
      });
    }
  }

  async endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    session.status = 'ended';
    session.endedAt = new Date().toISOString();
    logAudit('session_ended', sessionId);
    console.log(`[session] ended: ${sessionId} (${session.transcripts.length} transcript entries)`);

    this._broadcast(sessionId, { type: 'status', data: { status: 'ended', endedAt: session.endedAt } });

    if (session.transcripts.length > 0) {
      session.status = 'documenting';
      this._broadcast(sessionId, { type: 'status', data: { status: 'documenting' } });

      try {
        session.document = await generateMedicalDocument(session);
        session.status = 'completed';
        logAudit('document_generated', sessionId);
        this._broadcast(sessionId, { type: 'document_ready', data: { sessionId } });
        console.log(`[session] document generated for: ${sessionId}`);
      } catch (err) {
        session.status = 'completed';
        console.error(`[session] document generation failed for ${sessionId}:`, err.message);
        this._broadcast(sessionId, { type: 'document_error', data: { error: err.message } });
      }
    } else {
      session.status = 'completed';
    }

    this._saveToDisk(session);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      mode: s.mode,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      languagePair: s.languagePair,
      transcriptCount: s.transcripts.length,
      hasDocument: !!s.document,
    }));
  }

  broadcastDelta(sessionId, entry) {
    this._broadcast(sessionId, { type: 'transcript_delta', data: entry });
  }

  registerDashboardClient(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.dashboardClients.add(ws);
    logAudit('dashboard_connected', sessionId, ws._socket?.remoteAddress || 'unknown');

    ws.on('close', () => {
      session.dashboardClients.delete(ws);
    });

    return true;
  }

  _broadcast(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const json = JSON.stringify(message);
    for (const client of session.dashboardClients) {
      if (client.readyState === 1) {
        client.send(json);
      }
    }
  }

  _saveToDisk(session) {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      const data = {
        id: session.id,
        mode: session.mode,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        languagePair: session.languagePair,
        transcripts: session.transcripts,
        document: session.document,
      };
      const path = `${SESSIONS_DIR}/${session.id}.json`;
      writeFileSync(path, JSON.stringify(data, null, 2));
      console.log(`[session] saved to ${path}`);
    } catch (err) {
      console.error(`[session] save failed:`, err.message);
    }
  }

  _loadFromDisk() {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(readFileSync(`${SESSIONS_DIR}/${file}`, 'utf8'));
        data.dashboardClients = new Set();
        this.sessions.set(data.id, data);
      }
      if (files.length > 0) {
        console.log(`[session] loaded ${files.length} sessions from disk`);
      }
    } catch {}
  }

  _cleanup() {
    const ttl = config.sessionTtlMinutes * 60_000;
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      if (session.status === 'active') continue;
      const ended = session.endedAt ? new Date(session.endedAt).getTime() : 0;
      if (now - ended > ttl) {
        this.sessions.delete(id);
        console.log(`[session] cleaned up expired: ${id}`);
      }
    }
  }
}

const sessionManager = new SessionManager();
sessionManager._loadFromDisk();
export { sessionManager };
