/**
 * Access control.
 *
 * - Dashboard + /api/*: a single operator secret, DASHBOARD_TOKEN, sent as
 *   `Authorization: Bearer <token>`. Browsers can't set headers on a
 *   WebSocket, so /dashboard/ws carries it in Sec-WebSocket-Protocol as
 *   `auth.<base64url(token)>` next to the real subprotocol `dashboard.v1`.
 *   Without DASHBOARD_TOKEN these endpoints are disabled (503).
 * - Twilio webhooks and the media-stream upgrade: X-Twilio-Signature
 *   (HMAC-SHA1 over URL + sorted POST params, keyed by TWILIO_AUTH_TOKEN),
 *   checked whenever TWILIO_AUTH_TOKEN is set.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logAudit } from './audit-logger.js';

export const DASHBOARD_WS_PROTOCOL = 'dashboard.v1';
const WS_TOKEN_PREFIX = 'auth.';
const MIN_TOKEN_LENGTH = 16;

/** Constant-time string comparison (both sides hashed to a fixed length first). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function tokenMatches(candidate) {
  return Boolean(candidate) && Boolean(config.dashboardToken) && safeEqual(candidate, config.dashboardToken);
}

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  return match ? match[1] : null;
}

/** Express middleware for the dashboard API. */
export function requireDashboardToken(req, res, next) {
  if (!config.dashboardToken) {
    return res.status(503).json({ error: 'Dashboard API disabled: set DASHBOARD_TOKEN on the server' });
  }
  if (tokenMatches(bearerToken(req))) return next();

  logAudit('auth_failed', null, req.ip, { path: req.originalUrl.split('?')[0] });
  res.set('WWW-Authenticate', 'Bearer realm="dashboard"');
  return res.status(401).json({ error: 'Unauthorized' });
}

/** Token carried in Sec-WebSocket-Protocol as `auth.<base64url>`, or null. */
export function tokenFromWebSocketProtocols(header) {
  const entry = String(header || '').split(',').map(p => p.trim()).find(p => p.startsWith(WS_TOKEN_PREFIX));
  if (!entry) return null;
  const token = Buffer.from(entry.slice(WS_TOKEN_PREFIX.length), 'base64url').toString('utf8');
  return token || null;
}

/** Check a /dashboard/ws upgrade request. */
export function checkDashboardUpgrade(req) {
  if (!config.dashboardToken) return { ok: false, status: 503 };
  if (tokenMatches(tokenFromWebSocketProtocols(req.headers['sec-websocket-protocol']))) return { ok: true };
  logAudit('auth_failed', null, req.socket?.remoteAddress || 'unknown', { path: '/dashboard/ws' });
  return { ok: false, status: 401 };
}

/** ws `handleProtocols`: answer with the real subprotocol, never echo the token. */
export function selectDashboardProtocol(protocols) {
  return protocols.has(DASHBOARD_WS_PROTOCOL) ? DASHBOARD_WS_PROTOCOL : false;
}

// --- Twilio request signatures --------------------------------------------

/**
 * Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST
 * param name and value, sorted by name)).
 * @param {Array<[string, string]>} params
 */
export function twilioSignature(authToken, url, params = []) {
  const data = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .reduce((acc, [key, value]) => acc + key + value, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

function normalizeHost(host) {
  return String(host || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/**
 * URLs Twilio may have signed. The signature covers the URL exactly as
 * configured in Twilio, which the server can only reconstruct: try the
 * forwarded host, the Host header and PUBLIC_HOST with the likely schemes.
 * (Trying several is safe: each still needs a valid HMAC.)
 */
function candidateUrls(req, schemes) {
  const hosts = [
    firstHeaderValue(req.headers['x-forwarded-host']),
    req.headers.host,
    normalizeHost(config.publicHost),
  ].filter(Boolean);
  const path = req.originalUrl || req.url;
  const urls = [];
  for (const host of new Set(hosts)) {
    for (const scheme of schemes) urls.push(`${scheme}://${host}${path}`);
  }
  return urls;
}

function formParams(req) {
  if (typeof req.rawBody === 'string') return [...new URLSearchParams(req.rawBody)];
  return Object.entries(req.body || {}).map(([k, v]) => [k, String(v)]);
}

/**
 * Verify that a request (HTTP webhook or WebSocket upgrade) came from Twilio.
 * Skipped (ok) when TWILIO_AUTH_TOKEN is unset or TWILIO_SKIP_SIGNATURE_CHECK=true.
 */
export function verifyTwilioRequest(req, { websocket = false } = {}) {
  if (!config.twilioAuthToken || config.twilioSkipSignatureCheck) return { ok: true, skipped: true };

  const signature = req.headers['x-twilio-signature'];
  if (!signature) return { ok: false, reason: 'missing X-Twilio-Signature', tried: [] };

  const params = !websocket && req.method === 'POST' ? formParams(req) : [];
  const tried = candidateUrls(req, websocket ? ['wss', 'ws', 'https'] : ['https', 'http']);
  const ok = tried.some(url => safeEqual(twilioSignature(config.twilioAuthToken, url, params), signature));
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch', tried };
}

export function logRejectedTwilioRequest(req, result) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  console.warn(
    `[auth] rejected request to ${path}: ${result.reason}` +
    (result.tried.length ? ` (checked ${result.tried.join(', ')})` : '') +
    '. If this was Twilio, make sure the URL configured in Twilio matches the Host your proxy forwards or PUBLIC_HOST.'
  );
  logAudit('twilio_signature_rejected', null, req.ip || req.socket?.remoteAddress || 'unknown', { path, reason: result.reason });
}

/** Express middleware for Twilio webhooks. */
export function requireTwilioSignature(req, res, next) {
  const result = verifyTwilioRequest(req);
  if (result.ok) return next();
  logRejectedTwilioRequest(req, result);
  return res.status(403).type('text/plain').send('Invalid Twilio signature');
}

/** express.urlencoded `verify` hook: keep the raw body for signature checks. */
export function keepRawBody(req, _res, buf) {
  req.rawBody = buf.toString('utf8');
}

// --- Startup check ---------------------------------------------------------

/**
 * @returns {{ fatal: string | null, warnings: string[] }}
 *   fatal: the server must not start (no DASHBOARD_TOKEN with NODE_ENV=production).
 */
export function checkSecurityConfig() {
  const warnings = [];
  let fatal = null;

  if (!config.dashboardToken) {
    if (config.isProduction) {
      fatal = 'DASHBOARD_TOKEN is not set and NODE_ENV=production: refusing to start. Set a long random DASHBOARD_TOKEN in .env (e.g. `openssl rand -hex 32`).';
    } else {
      warnings.push('DASHBOARD_TOKEN is not set: the dashboard API (/api/*) and /dashboard/ws are DISABLED (503). Set it in .env to use the dashboard.');
    }
  } else if (config.dashboardToken.length < MIN_TOKEN_LENGTH) {
    warnings.push(`DASHBOARD_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; use a long random value (e.g. \`openssl rand -hex 32\`).`);
  }

  if (!config.twilioAuthToken) {
    warnings.push('TWILIO_AUTH_TOKEN is not set: Twilio request signatures are NOT verified, so anyone who finds the webhook or media-stream URL can use them.');
  } else if (config.twilioSkipSignatureCheck) {
    warnings.push('TWILIO_SKIP_SIGNATURE_CHECK=true: Twilio request signatures are NOT verified. Use only while debugging.');
  }

  return { fatal, warnings };
}
