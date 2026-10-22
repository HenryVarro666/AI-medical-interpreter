import { OpenAIRealtimeClient } from './openai-client.js';
import { config } from './config.js';
import { sessionManager } from './session-manager.js';
import { checkCallAllowed, registerCall, unregisterCall, trackAudioChunk } from './call-guard.js';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// Request values (From, mode, model) end up inside TwiML attributes.
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

const TWILIO_API_TIMEOUT_MS = 5000;

/**
 * End a live call through the Twilio REST API (update the Call to
 * Status=completed). Never throws.
 * @returns {Promise<{ ok: boolean, skipped?: boolean, status?: number, error?: string }>}
 */
export async function hangupCall(callSid) {
  if (!callSid) {
    console.warn('[twilio] REST hang-up skipped: stream has no CallSid');
    return { ok: false, skipped: true, error: 'missing CallSid' };
  }
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    console.warn(`[twilio] REST hang-up skipped for ${callSid}: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set`);
    return { ok: false, skipped: true, error: 'missing Twilio credentials' };
  }
  try {
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
      {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Status=completed',
        signal: AbortSignal.timeout(TWILIO_API_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[twilio] REST hang-up failed for ${callSid}: ${res.status} ${body.slice(0, 300)}`);
      return { ok: false, status: res.status, error: `Twilio API error ${res.status}` };
    }
    console.log(`[twilio] call completed via REST: ${callSid}`);
    return { ok: true, status: res.status };
  } catch (err) {
    console.error(`[twilio] REST hang-up failed for ${callSid}:`, err.message);
    return { ok: false, error: err.message };
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
  // Twilio runs the verbs after </Connect> only once our server closes the
  // stream, so <Hangup/> turns that close into a hang-up (see endCall).
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
  <Hangup/>
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
  let callKey = null; // id this call is registered under in call-guard
  let openai = null;
  let session = null;
  let ending = false;
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

  // Idempotent: runs on Twilio's 'stop', on socket close and from endCall().
  function cleanup() {
    openai?.close();
    openai = null;
    if (callKey) unregisterCall(callKey);
    if (session) {
      sessionManager.endSession(session.id);
      session = null;
    }
  }

  /**
   * End the call from our side. Stops the interpreter first so nothing more
   * is played or recorded, completes the call through the Twilio REST API,
   * then closes the media stream. If the REST call is skipped (no
   * credentials) or fails, closing the stream still ends the call through
   * the <Hangup/> that follows <Connect> in the TwiML.
   */
  async function endCall(reason, note) {
    if (ending) return;
    ending = true;
    console.log(`[twilio] ending call ${callSid || streamSid}: ${reason}`);
    try {
      if (note && session) sessionManager.addTranscript(session.id, { role: 'system', text: note });
      cleanup();
      const result = await hangupCall(callSid);
      if (!result.ok) console.warn(`[twilio] closing media stream ${streamSid} so Twilio hangs up via TwiML`);
    } catch (err) {
      console.error('[twilio] endCall error:', err?.message || err);
    } finally {
      if (ws.readyState === ws.OPEN) ws.close(1000, reason);
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
        callKey = callSid || streamSid;

        const params = msg.start.customParameters || {};
        mode = params.mode || config.defaultMode;
        modelOverride = params.model || null;
        // Same value checkCallAllowed() saw in the webhook, so the history
        // recorded here is what the next call from this number is checked against.
        const callerNumber = params.from || 'unknown';

        console.log(`[twilio] stream started: ${streamSid} | mode=${mode} model=${modelOverride || 'default'}`);

        registerCall(callKey, callerNumber, {
          onMaxDuration: () => endCall('max_duration', '[Call ended: maximum call duration reached]'),
        });
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

        // This handler is async, so a rejection here would be unhandled and
        // take the whole server down (e.g. OpenAI rejects the key, or the
        // caller hangs up and cleanup() closes the socket mid-connect).
        const client = openai;
        try {
          await client.connect();
        } catch (err) {
          console.error('[openai] connect failed:', err?.message || err);
          // If cleanup() already ran, the call is over and there is nothing to end.
          if (openai === client) endCall('openai_unavailable', '[Call ended: interpreter service unavailable]');
        }
        break;
      }

      case 'media':
        if (ending) break;
        if (openai?.isReady()) {
          const guard = trackAudioChunk(callKey, msg.media.payload);
          if (guard.action === 'hangup_silence') {
            endCall('extended_silence', '[Call ended due to extended silence]');
            break;
          }
          if (guard.action === 'warn_silence') {
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
