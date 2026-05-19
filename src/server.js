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
import { getAvailableModels } from './openai-client.js';
import { syncTwilioWebhook } from './twilio-sync.js';

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

// --- Public host -----------------------------------------------------------
app.get('/api/public-host', (req, res) => {
  const host = config.publicHost || req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ host });
});

// --- Models API ------------------------------------------------------------
app.get('/api/models', (_req, res) => {
  res.json({
    available: getAvailableModels(),
    defaults: {
      translator: config.openaiTranslateModel,
      intake: config.openaiModel,
    },
  });
});

// --- Twilio webhook sync ---------------------------------------------------
app.post('/api/twilio-sync', async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl is required' });
  const result = await syncTwilioWebhook(webhookUrl);
  res.json(result);
});

app.get('/api/twilio-config', (_req, res) => {
  res.json({
    configured: !!(config.twilioAccountSid && config.twilioAuthToken && config.twilioPhoneNumber),
    phoneNumber: config.twilioPhoneNumber ? config.twilioPhoneNumber.replace(/.(?=.{4})/g, '*') : null,
  });
});

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

// --- Demo: seed a mock session for local preview ---------------------------
app.post('/api/demo', async (_req, res) => {
  const session = sessionManager.createSession('demo-stream', 'demo-call', 'intake');

  const lines = [
    { role: 'translation', text: 'Hello, I am the medical intake specialist. May I have your full name and date of birth please?' },
    { role: 'caller', text: '你好，我叫张伟，1985年3月15日出生。' },
    { role: 'translation', text: 'Thank you, Zhang Wei. What brings you in today? What is the main reason for your call?' },
    { role: 'caller', text: '我头疼，已经三天了，越来越严重。' },
    { role: 'translation', text: 'I see, a headache for three days that is getting worse. On a scale of 1 to 10, how would you rate the pain right now?' },
    { role: 'caller', text: '大概7分吧，就是持续性的钝痛，主要在前额和太阳穴。' },
    { role: 'translation', text: 'A constant dull pain at 7 out of 10, mainly in the forehead and temples. Are you currently taking any medications for this or anything else?' },
    { role: 'caller', text: '我吃了布洛芬，400毫克，一天吃了两次，但是没什么效果。我平时还在吃降压药，氨氯地平5毫克，每天一次。' },
    { role: 'translation', text: 'Understood — ibuprofen 400mg twice daily with no relief, and amlodipine 5mg daily for blood pressure. Do you have any allergies to medications, foods, or other substances?' },
    { role: 'caller', text: '我对青霉素过敏，会起皮疹。对其他的不过敏。' },
    { role: 'translation', text: 'Penicillin allergy causing rash, noted. Any other ongoing medical conditions besides high blood pressure?' },
    { role: 'caller', text: '高血压，已经五年了。还有轻度脂肪肝，去年体检查出来的。' },
    { role: 'translation', text: 'Hypertension for 5 years and mild fatty liver diagnosed last year. Have you had any surgeries or hospitalizations?' },
    { role: 'caller', text: '没有做过手术，也没有住过院。' },
    { role: 'translation', text: 'No surgeries or hospitalizations. Any significant medical conditions in your immediate family?' },
    { role: 'caller', text: '我父亲有糖尿病，母亲有高血压。' },
    { role: 'translation', text: 'Father with diabetes, mother with hypertension. Do you smoke, drink alcohol, or use any other substances?' },
    { role: 'caller', text: '不抽烟，偶尔喝点啤酒，大概一周一两次。' },
    { role: 'translation', text: 'Non-smoker, occasional beer 1-2 times per week. Any other symptoms along with the headache — nausea, vision changes, dizziness, fever, neck stiffness?' },
    { role: 'caller', text: '有一点恶心，但没有吐。视力正常，没有发烧。' },
    { role: 'translation', text: 'Mild nausea without vomiting, no vision changes, no fever. Let me confirm what I have: Zhang Wei, born March 15 1985, presenting with a 3-day worsening headache rated 7/10, constant dull pain in the forehead and temples, with mild nausea. Current medications are ibuprofen 400mg BID and amlodipine 5mg daily. Penicillin allergy. History of hypertension and fatty liver. Is that all correct?' },
    { role: 'caller', text: '对的，都对。' },
    { role: 'translation', text: 'Thank you, Zhang Wei. The doctor will review all of this and be with you shortly. Is there anything else you would like the doctor to know?' },
    { role: 'caller', text: '没有了，谢谢。' },
    { role: 'translation', text: 'You are welcome. Take care and the doctor will see you soon.' },
  ];

  for (const line of lines) {
    sessionManager.addTranscript(session.id, line);
    await new Promise(r => setTimeout(r, 50));
  }

  await sessionManager.endSession(session.id);

  res.json({ sessionId: session.id, message: 'Demo session created. Open the dashboard to view.' });
});

// --- HTTP server + WebSocket servers ---------------------------------------
const server = createServer(app);

const twilioWss = new WebSocketServer({ noServer: true });
twilioWss.on('connection', handleMediaStream);

const dashboardWss = new WebSocketServer({ noServer: true });
dashboardWss.on('connection', handleDashboardConnection);

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  // Strip permessage-deflate to prevent ngrok compression conflicts
  delete req.headers['sec-websocket-extensions'];

  if (pathname === '/twilio/media-stream') {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  } else if (pathname === '/dashboard/ws') {
    dashboardWss.handleUpgrade(req, socket, head, (ws) => {
      dashboardWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

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
