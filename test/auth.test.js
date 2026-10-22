import './helpers/env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const DASHBOARD_TOKEN = 'test-dashboard-token-0123456789abcdef';
process.env.DASHBOARD_TOKEN = DASHBOARD_TOKEN;

const { config } = await import('../src/config.js');
const { createAppServer } = await import('../src/app.js');
const { twilioSignature, checkSecurityConfig, safeEqual } = await import('../src/auth.js');
const { sessionManager } = await import('../src/session-manager.js');

let server;
let base;
let host;

before(async () => {
  server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Run fn with config overrides, restoring them afterwards. */
async function withConfig(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map(k => [k, config[k]]));
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

function dashboardSocket(path, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}${path}`, protocols);
    // The server sends session_state right away; it can arrive with the
    // handshake, before a listener added after 'open' would see it.
    const firstMessage = new Promise(r => ws.once('message', data => r(JSON.parse(data))));
    ws.once('open', () => resolve({ ws, status: 101, protocol: ws.protocol, firstMessage }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }));
    ws.once('error', () => {});
  });
}

const tokenProtocol = (token) => `auth.${Buffer.from(token).toString('base64url')}`;

function webhookBody(params) {
  return new URLSearchParams(params).toString();
}

// --- Dashboard token -------------------------------------------------------

const API_ROUTES = [
  ['GET', '/api/sessions'],
  ['GET', '/api/sessions/some-id'],
  ['GET', '/api/sessions/some-id/document'],
  ['GET', '/api/public-host'],
  ['GET', '/api/models'],
  ['GET', '/api/twilio-config'],
  ['POST', '/api/twilio-sync'],
  ['POST', '/api/demo'],
];

test('every /api route returns 401 without a token', async () => {
  for (const [method, path] of API_ROUTES) {
    const res = await fetch(`${base}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
  }
});

test('/api returns 401 with a wrong token', async () => {
  for (const token of ['wrong', `${DASHBOARD_TOKEN}x`, DASHBOARD_TOKEN.slice(0, -1)]) {
    const res = await fetch(`${base}/api/sessions`, { headers: auth(token) });
    assert.equal(res.status, 401, token);
  }
  const basic = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Basic ${Buffer.from(`x:${DASHBOARD_TOKEN}`).toString('base64')}` } });
  assert.equal(basic.status, 401, 'only Bearer is accepted');
});

test('/api returns 200 with the right token', async () => {
  const res = await fetch(`${base}/api/sessions`, { headers: auth(DASHBOARD_TOKEN) });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));

  const models = await fetch(`${base}/api/models`, { headers: auth(DASHBOARD_TOKEN) });
  assert.equal(models.status, 200);
});

test('without DASHBOARD_TOKEN the dashboard API and WebSocket are disabled (503)', async () => {
  await withConfig({ dashboardToken: '' }, async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: auth('') });
    assert.equal(res.status, 503);
    const { status } = await dashboardSocket('/dashboard/ws?sessionId=x', ['dashboard.v1', tokenProtocol('anything')]);
    assert.equal(status, 503);
  });
});

test('/health and the static dashboard shell stay public', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /login-form/);
});

test('dashboard WebSocket upgrade needs the token', async () => {
  const session = sessionManager.createSession('MZ-ws-auth', 'CA-ws-auth', 'translator');
  const path = `/dashboard/ws?sessionId=${session.id}`;

  assert.equal((await dashboardSocket(path, ['dashboard.v1'])).status, 401, 'no token');
  assert.equal((await dashboardSocket(path, ['dashboard.v1', tokenProtocol('wrong')])).status, 401, 'wrong token');

  const ok = await dashboardSocket(path, ['dashboard.v1', tokenProtocol(DASHBOARD_TOKEN)]);
  assert.equal(ok.status, 101);
  assert.equal(ok.protocol, 'dashboard.v1', 'server picks the real subprotocol, not the token');
  const first = await ok.firstMessage;
  assert.equal(first.type, 'session_state');
  assert.equal(first.data.id, session.id);
  ok.ws.close();
  sessionManager.endSession(session.id);
});

// --- Twilio signatures -----------------------------------------------------

test('twilioSignature matches Twilio\'s published example', () => {
  const params = Object.entries({
    CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212',
  });
  assert.equal(
    twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params),
    'RSOYDt4T1cUTdK1PDd93/VVr8B8=',
  );
});

test('voice webhook accepts a valid Twilio signature', async () => {
  const params = { CallSid: 'CA-signed', From: '+15558880000', To: '+15550001111' };
  const url = `http://${host}/twilio/incoming-call?mode=intake`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilioSignature(config.twilioAuthToken, url, Object.entries(params)),
    },
    body: webhookBody(params),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Connect>/);
});

test('voice webhook signature is checked against the forwarded https URL too', async () => {
  const params = { CallSid: 'CA-proxied', From: '+15558880001' };
  const publicUrl = 'https://interpreter.example.test/twilio/incoming-call';
  const res = await fetch(`${base}/twilio/incoming-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-Host': 'interpreter.example.test',
      'X-Twilio-Signature': twilioSignature(config.twilioAuthToken, publicUrl, Object.entries(params)),
    },
    body: webhookBody(params),
  });
  assert.equal(res.status, 200);
});

test('voice webhook rejects missing, forged or tampered signatures', async () => {
  const params = { CallSid: 'CA-forged', From: '+15558880002' };
  const url = `http://${host}/twilio/incoming-call`;
  const post = (headers, body = webhookBody(params)) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });

  assert.equal((await post({})).status, 403, 'missing');
  assert.equal((await post({ 'X-Twilio-Signature': twilioSignature('not-the-token', url, Object.entries(params)) })).status, 403, 'wrong key');

  const signature = twilioSignature(config.twilioAuthToken, url, Object.entries(params));
  const tampered = webhookBody({ ...params, From: '+15559999999' });
  assert.equal((await post({ 'X-Twilio-Signature': signature }, tampered)).status, 403, 'tampered body');
});

test('GET webhook signature covers the query string', async () => {
  const url = `http://${host}/twilio/incoming-call?From=%2B15558880003&CallSid=CA-get`;
  const good = await fetch(url, { headers: { 'X-Twilio-Signature': twilioSignature(config.twilioAuthToken, url) } });
  assert.equal(good.status, 200);
  const bad = await fetch(url.replace('CA-get', 'CA-other'), { headers: { 'X-Twilio-Signature': twilioSignature(config.twilioAuthToken, url) } });
  assert.equal(bad.status, 403);
});

test('media-stream upgrade requires a valid Twilio signature', async () => {
  const open = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/twilio/media-stream`, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => {});
  });

  assert.equal(await open({}), 403, 'missing');
  assert.equal(await open({ 'X-Twilio-Signature': 'bm9wZQ==' }), 403, 'forged');
  const signed = twilioSignature(config.twilioAuthToken, `wss://${host}/twilio/media-stream`);
  assert.equal(await open({ 'X-Twilio-Signature': signed }), 101);
});

test('signature checks are skipped when TWILIO_AUTH_TOKEN is not set', async () => {
  await withConfig({ twilioAuthToken: '' }, async () => {
    const res = await fetch(`${base}/twilio/incoming-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: webhookBody({ CallSid: 'CA-unsigned', From: '+15558880004' }),
    });
    assert.equal(res.status, 200);
  });
});

// --- Startup check ---------------------------------------------------------

test('production refuses to start without DASHBOARD_TOKEN; development only warns', async () => {
  await withConfig({ dashboardToken: '', isProduction: true }, () => {
    assert.match(checkSecurityConfig().fatal, /DASHBOARD_TOKEN/);
  });
  await withConfig({ dashboardToken: '', isProduction: false }, () => {
    const { fatal, warnings } = checkSecurityConfig();
    assert.equal(fatal, null);
    assert.ok(warnings.some(w => /DASHBOARD_TOKEN/.test(w)));
  });
  await withConfig({ isProduction: true }, () => {
    assert.equal(checkSecurityConfig().fatal, null);
  });
});

test('safeEqual compares exactly', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
