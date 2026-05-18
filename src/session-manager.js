import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { config } from './config.js';
import { logAudit } from './audit-logger.js';
import { generateMedicalDocument } from './doc-generator.js';

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

export const sessionManager = new SessionManager();
