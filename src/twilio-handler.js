import { OpenAIRealtimeClient } from './openai-client.js';
import { config } from './config.js';
import { sessionManager } from './session-manager.js';
import { checkCallAllowed, registerCall, unregisterCall, trackAudioChunk } from './call-guard.js';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// Request values (From, mode, model) end up inside TwiML attributes.
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

async function hangupCall(callSid) {
  if (!callSid || !config.twilioAccountSid || !config.twilioAuthToken) return;
  try {
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Status=completed',
      }
    );
    console.log(`[twilio] force-hangup: ${callSid}`);
  } catch (err) {
    console.error(`[twilio] hangup failed:`, err.message);
  }
}

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
  <Say>${escapeXml(guard.reason)}</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml').send(twiml);
    return;
  }

  const mode = req.query?.mode || req.body?.mode || config.defaultMode;
  const model = req.query?.model || req.body?.model || '';
  const wsUrl = `wss://${host}/twilio/media-stream`;

  console.log(`[twilio] incoming call: mode=${mode} model=${model}`);

  const greeting = mode === 'intake'
    ? 'Connecting you to the medical intake system. A specialist will collect your information.'
    : 'Connecting you to the AI translator. Please start speaking.';

  // Twilio drops query strings from the Stream URL, so everything the media
  // stream needs (including the caller number for per-number rate limiting)
  // goes through <Parameter> and arrives in start.customParameters.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(greeting)}</Say>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="mode" value="${escapeXml(mode)}" />
      <Parameter name="model" value="${escapeXml(model)}" />
      <Parameter name="from" value="${escapeXml(callerNumber)}" />
    </Stream>
  </Connect>
</Response>`;

  res.set('ngrok-skip-browser-warning', 'true');
  res.type('text/xml').send(twiml);
}

/**
 * @param {import('ws').WebSocket} ws  Twilio Media Streams socket
 * @param {import('http').IncomingMessage} req
 * @param {{ createOpenAIClient?: (mode: string, model: string | null) => OpenAIRealtimeClient }} [deps]
 *   Injection point for tests; the server passes only (ws, req).
 */
export function handleMediaStream(ws, req, {
  createOpenAIClient = (mode, model) => new OpenAIRealtimeClient(mode, model),
} = {}) {
  console.log(`[twilio] Media stream WS opened`);

  let streamSid = null;
  let callSid = null;
  let openai = null;
  let session = null;
  let silenceWarned = false;
  let mode = config.defaultMode;
  let modelOverride = null;

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

        const params = msg.start.customParameters || {};
        mode = params.mode || config.defaultMode;
        modelOverride = params.model || null;
        // Same value checkCallAllowed() saw in the webhook, so the history
        // recorded here is what the next call from this number is checked against.
        const callerNumber = params.from || 'unknown';

        console.log(`[twilio] stream started: ${streamSid} | mode=${mode} model=${modelOverride || 'default'}`);

        registerCall(callSid || streamSid, callerNumber);
        session = sessionManager.createSession(streamSid, callSid, mode);

        openai = createOpenAIClient(mode, modelOverride);
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
          if (guard.action === 'hangup_silence') {
            sessionManager.addTranscript(session?.id, {
              role: 'system',
              text: '[Call ended due to extended silence]',
            });
            hangupCall(callSid);
          } else if (guard.action === 'warn_silence' && !silenceWarned) {
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
