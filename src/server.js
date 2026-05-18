import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config } from './config.js';
import { handleIncomingCall, handleMediaStream } from './twilio-handler.js';
import { handleDashboardConnection } from './dashboard-handler.js';
import { sessionManager } from './session-manager.js';
import { logAudit } from './audit-logger.js';
import { getCallStats } from './call-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Static files (dashboard frontend) ------------------------------------
app.use(express.static(join(__dirname, '..', 'public')));

// --- Health check ----------------------------------------------------------
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'ai-medical-interpreter',
  ...getCallStats(),
}));

// --- Twilio webhooks -------------------------------------------------------
app.post('/twilio/incoming-call', handleIncomingCall);
app.get('/twilio/incoming-call', handleIncomingCall);

// --- Dashboard REST API ----------------------------------------------------
app.get('/api/sessions', (_req, res) => {
  res.json(sessionManager.listSessions());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  logAudit('session_data_accessed', session.id, req.ip);
  res.json({
    id: session.id,
    mode: session.mode,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    languagePair: session.languagePair,
    transcripts: session.transcripts,
    hasDocument: !!session.document,
  });
});

app.get('/api/sessions/:id/document', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.document) return res.status(404).json({ error: 'Document not yet generated' });

  logAudit('document_accessed', session.id, req.ip);
  res.json(session.document);
});

// --- HTTP server + WebSocket servers ---------------------------------------
const server = createServer(app);

const twilioWss = new WebSocketServer({ server, path: '/twilio/media-stream' });
twilioWss.on('connection', handleMediaStream);

const dashboardWss = new WebSocketServer({ server, path: '/dashboard/ws' });
dashboardWss.on('connection', handleDashboardConnection);

server.listen(config.port, () => {
  console.log('─'.repeat(60));
  console.log(`  AI Phone Call Translator listening on :${config.port}`);
  console.log(`  TwiML webhook : POST /twilio/incoming-call`);
  console.log(`  Media stream  : WS   /twilio/media-stream`);
  console.log(`  Dashboard     : http://localhost:${config.port}/`);
  console.log(`  Dashboard WS  : WS   /dashboard/ws?sessionId=<id>`);
  console.log(`  Sessions API  : GET  /api/sessions`);
  console.log(`  Languages     : ${config.speakerALang}  ⇄  ${config.speakerBLang}`);
  console.log(`  Voice         : ${config.voice}  (clone bridge: ${config.enableVoiceClone ? 'ON' : 'off'})`);
  console.log('─'.repeat(60));
});
