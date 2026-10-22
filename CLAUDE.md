# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start with auto-reload (node --watch)
npm start            # Production start
npm test             # node:test suite in test/ (Twilio, OpenAI and fetch are faked)
ngrok http 5050      # Expose locally for Twilio (separate terminal)
```

No build step, no linter. ES modules throughout (Node >= 20).

## Architecture

Real-time medical phone call interpreter: Twilio Media Streams ↔ Node.js server ↔ OpenAI Realtime API. Two modes: **translator** (bidirectional translation) and **intake** (AI-driven structured medical interview).

### Audio Pipeline — Zero Transcoding

Twilio and OpenAI both use G.711 u-law 8kHz (`audio/pcmu`). The server passes base64 strings through without any encoding/decoding. This is the source of the ~400ms latency.

### Dual WebSocket Architecture

One HTTP server, two WebSocket servers routed via `server.on('upgrade')`:
- `/twilio/media-stream` — Twilio audio frames (binary, latency-critical)
- `/dashboard/ws?sessionId=<id>` — Browser dashboard (JSON transcript events)

The `upgrade` handler strips `sec-websocket-extensions` to prevent ngrok compression conflicts.

### Request Flow

1. Twilio POSTs `/twilio/incoming-call` → server returns TwiML with `<Stream>` + `<Parameter>` tags
2. Twilio opens WS to `/twilio/media-stream` → `handleMediaStream()` reads mode/model from `start.customParameters`
3. `OpenAIRealtimeClient` connects to OpenAI, sends `session.update`
4. Audio flows: Twilio → `sendAudio()` → OpenAI → `audio` event → `forwardAudio()` → Twilio
5. Transcripts emitted via EventEmitter → `sessionManager.addTranscript()` → broadcast to dashboard WS
6. On call end → `endSession()` → GPT-4o generates SOAP note → saved to `data/sessions/<id>.json`

### OpenAI GA API Differences (Critical)

The codebase uses the **GA API** (not beta). Key differences from older docs/examples:

| What | GA API | Old Beta API |
|------|--------|-------------|
| Auth header | `Authorization: Bearer` only | Had `OpenAI-Beta: realtime=v1` |
| Session type | `session.type: 'realtime'` | Not required |
| Audio format | `audio.input.format: { type: 'audio/pcmu' }` | `input_audio_format: 'g711_ulaw'` |
| Voice | `audio.output.voice` | `voice` (top-level) |
| Modalities | `output_modalities` | `modalities` |
| Send audio | `input_audio_buffer.append` (conversation) / `session.input_audio_buffer.append` (translate) | `input_audio_buffer.append` |
| Audio events | `response.output_audio.delta` | `response.audio.delta` |
| Transcript events | `response.output_audio_transcript.done` | `response.audio_transcript.done` |

**Translate model** (`gpt-realtime-translate`) uses a completely different endpoint (`/v1/realtime/translations`) with `session.` prefix on all events.

### Mode Differences in openai-client.js

`OpenAIRealtimeClient` branches behavior by mode:

- **`_configureConversationSession()`** — used by translator (with general model) and intake. Sets instructions, VAD, voice.
- **`_configureTranslateSession()`** — used when model is `gpt-realtime-translate`. Sets `audio.output.language`, no instructions.
- **Event handlers**: `_handleConversationEvent()`, `_handleTranslateEvent()`, `_handleWhisperEvent()` — each model family has different event names.
- **Echo gate**: intake mode uses 2s tail (vs 800ms for translator) and pre-locks `aiSpeaking=true` before initial greeting.
- **sendAudio prefix**: translate model requires `session.input_audio_buffer.append`, conversation model uses `input_audio_buffer.append`.

### Session Lifecycle

```
active → ended → documenting → completed
```

Sessions persist to `data/sessions/<uuid>.json` on completion. Loaded back on server restart via `_loadFromDisk()`. TTL cleanup runs every 60s for in-memory sessions.

### Twilio Parameter Passing

Twilio strips query params from Stream WebSocket URLs. Mode, model and the caller number (`from`, used for per-number rate limiting) are passed via `<Parameter>` TwiML elements and read from `msg.start.customParameters` in the `start` event.

### Call Guard

Three tiers: rate limiting (per-number, checked in the webhook, recorded at stream start) → duration cap (`MAX_CALL_DURATION_MIN`) → silence detection (warn at `MAX_SILENCE_SEC`, hang up at 2×). Both hang-ups go through `endCall()` in `twilio-handler.js`: close OpenAI and end the session, complete the call via the Twilio REST API (`Status=completed`), then close the media stream; the `<Hangup/>` after `<Connect>` ends the call if the REST request is skipped or fails.

### Access control (`src/auth.js`)

`src/app.js` builds the Express app + WebSocket routing (`createAppServer()`, used by tests); `src/server.js` runs the startup security check and listens.

- `/api/*` needs `Authorization: Bearer <DASHBOARD_TOKEN>` (constant-time compare). `/dashboard/ws` gets the token in `Sec-WebSocket-Protocol` as `auth.<base64url(token)>` next to `dashboard.v1` (browsers can't set WS headers). Without `DASHBOARD_TOKEN` both return 503; with `NODE_ENV=production` the server refuses to start. The static dashboard shell and `/health` stay public; the page asks for the token and keeps it in `sessionStorage`.
- `/twilio/incoming-call` and the `/twilio/media-stream` upgrade verify `X-Twilio-Signature` when `TWILIO_AUTH_TOKEN` is set. The signed URL is rebuilt from `X-Forwarded-Host` / `Host` / `PUBLIC_HOST` (https/http for the webhook, wss for the stream); mismatches return 403 and are logged with the URLs tried. `TWILIO_SKIP_SIGNATURE_CHECK=true` disables this for debugging.

## Config

All via `.env` (see `.env.example`). `OPENAI_API_KEY` is required to start; `DASHBOARD_TOKEN` is required for the dashboard/API (and to start at all with `NODE_ENV=production`). `config.js` fails fast on missing required keys. Key non-obvious configs:

- `PUBLIC_HOST` — ngrok hostname, auto-detected from request headers if not set
- `WHISPER_LANGUAGE_HINT` — ISO 639-1 code to bias ASR (helps with code-switching)
- `ENABLE_TRANSCRIPT_CLEANING` — optional GPT-4o-mini post-ASR cleanup (+200-400ms)
- `DEBUG_LOG_TRANSCRIPTS` — logs PHI to console, off by default

## Data Directories

`data/` is gitignored. Contains:
- `data/audit.log` — append-only JSONL audit trail
- `data/sessions/*.json` — persisted session data with transcripts and SOAP notes
