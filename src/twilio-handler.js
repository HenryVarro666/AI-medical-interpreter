import { OpenAIRealtimeClient } from './openai-client.js';
import { config } from './config.js';
import { sessionManager } from './session-manager.js';
import { checkCallAllowed, registerCall, unregisterCall, trackAudioChunk } from './call-guard.js';

export function handleIncomingCall(req, res) {
  const rawHost = config.publicHost || req.headers.host || '';
  const host = rawHost
    .replace(/^wss?:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  const callerNumber = req.body?.From || req.query?.From || 'unknown';
  const callSid = req.body?.CallSid || req.query?.CallSid || null;

  const guard = checkCallAllowed(callSid, callerNumber);
  if (!guard.allowed) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${guard.reason}</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml').send(twiml);
    return;
  }

  const mode = req.query?.mode || req.body?.mode || config.defaultMode;
  const model = req.query?.model || req.body?.model || '';
  let wsUrl = `wss://${host}/twilio/media-stream?mode=${mode}`;
  if (model) wsUrl += `&amp;model=${model}`;

  console.log(`[twilio] incoming call: mode=${mode} model=${model} wsUrl=${wsUrl}`);

  const greeting = mode === 'intake'
    ? 'Connecting you to the medical intake system. A specialist will collect your information.'
    : 'Connecting you to the AI translator. Please start speaking.';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.set('ngrok-skip-browser-warning', 'true');
  res.type('text/xml').send(twiml);
}

export function handleMediaStream(ws, req) {
  console.log(`[twilio] Media stream WS opened from ${req.socket.remoteAddress}`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[twilio] WS raw URL: ${req.url}`);
  const mode = url.searchParams.get('mode') || config.defaultMode;
  const modelOverride = url.searchParams.get('model') || null;

  let streamSid = null;
  let callSid = null;
  let openai = null;
  let session = null;
  let silenceWarned = false;

  function forwardAudio(audioBase64) {
    if (ws.readyState !== ws.OPEN || !streamSid) return;
    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: audioBase64 },
    }));
  }

  function cleanup() {
    openai?.close();
    openai = null;
    if (callSid) unregisterCall(callSid);
    if (session) {
      sessionManager.endSession(session.id);
      session = null;
    }
  }

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('[twilio] bad JSON', err);
      return;
    }

    switch (msg.event) {
      case 'connected':
        break;

      case 'start': {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid || null;
        console.log(`[twilio] stream started: ${streamSid} (mode: ${mode})`);

        registerCall(callSid || streamSid, 'unknown');
        session = sessionManager.createSession(streamSid, callSid, mode);

        openai = new OpenAIRealtimeClient(mode, modelOverride);
        openai.on('audio', forwardAudio);
        openai.on('transcript', (entry) => {
          sessionManager.addTranscript(session.id, entry);
        });
        openai.on('transcript_delta', (entry) => {
          sessionManager.broadcastDelta(session.id, entry);
        });
        openai.on('error', (err) => {
          console.error('[openai] error:', err?.message || err);
        });

        await openai.connect();
        break;
      }

      case 'media':
        if (openai?.isReady()) {
          const guard = trackAudioChunk(callSid || streamSid, msg.media.payload);
          if (guard.action === 'warn_silence' && !silenceWarned) {
            silenceWarned = true;
            sessionManager.addTranscript(session?.id, {
              role: 'system',
              text: '[Extended silence detected — no speech received]',
            });
          }
          openai.sendAudio(msg.media.payload);
        }
        break;

      case 'mark':
        break;

      case 'stop':
        console.log(`[twilio] stream stopped: ${streamSid}`);
        cleanup();
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[twilio] media stream WS closed');
    cleanup();
  });

  ws.on('error', (err) => {
    console.error('[twilio] WS error:', err?.message || err);
  });
}
