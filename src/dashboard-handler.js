import { sessionManager } from './session-manager.js';
import { logAudit } from './audit-logger.js';

export function handleDashboardConnection(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Missing sessionId parameter' } }));
    ws.close(4000, 'Missing sessionId');
    return;
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Session not found' } }));
    ws.close(4004, 'Session not found');
    return;
  }

  sessionManager.registerDashboardClient(sessionId, ws);

  ws.send(JSON.stringify({
    type: 'session_state',
    data: {
      id: session.id,
      mode: session.mode,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      languagePair: session.languagePair,
      transcripts: session.transcripts,
      hasDocument: !!session.document,
    },
  }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch { return; }

    if (msg.type === 'generate_document' && session.status === 'completed' && !session.document) {
      sessionManager.endSession(sessionId);
    }
  });

  ws.on('close', () => {
    session.dashboardClients.delete(ws);
  });
}
