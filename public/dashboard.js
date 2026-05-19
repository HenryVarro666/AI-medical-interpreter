const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let ws = null;
let currentSessionId = null;
let autoScroll = true;
let restLoaded = false;

// --- Session list ----------------------------------------------------------

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    renderSessionList(sessions);
    return sessions;
  } catch { return []; }
}

function renderSessionList(sessions) {
  const select = $('#session-select');
  const prev = select.value;
  select.innerHTML = '<option value="">-- Select a session --</option>';

  const sorted = sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const time = new Date(s.startedAt).toLocaleTimeString();
    const icon = s.status === 'active' ? '\u25CF' : '\u25CB';
    const modeLabel = s.mode === 'intake' ? 'INTAKE' : 'TRANSLATE';
    opt.textContent = `${icon} ${time} ${modeLabel} (${s.languagePair.a}\u2194${s.languagePair.b}) [${s.status}]`;
    select.appendChild(opt);
  }

  if (prev && sessions.find(s => s.id === prev)) {
    select.value = prev;
  }
}

// --- WebSocket connection --------------------------------------------------

async function connectToSession(sessionId) {
  if (ws) { ws.close(); ws = null; }
  if (!sessionId) {
    currentSessionId = null;
    showNoSession();
    return;
  }

  currentSessionId = sessionId;
  restLoaded = false;
  showSessionView();
  clearTranscript();
  clearDocument();

  await loadSessionViaREST(sessionId);

  setConnectionStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/dashboard/ws?sessionId=${sessionId}`);

  ws.onopen = () => setConnectionStatus('connected');

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'session_state':
        handleSessionState(msg.data);
        break;
      case 'transcript':
        addTranscriptLine(msg.data);
        break;
      case 'status':
        updateSessionStatus(msg.data);
        break;
      case 'document_ready':
        fetchAndRenderDocument(msg.data.sessionId);
        break;
      case 'transcript_delta':
        appendDelta(msg.data);
        break;
      case 'transcript_corrected':
        correctTranscriptLine(msg.data);
        break;
      case 'document_error':
        showDocumentError(msg.data.error);
        break;
      case 'error':
        console.error('[dashboard] server error:', msg.data.message);
        break;
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    setTimeout(() => {
      if (currentSessionId === sessionId) connectToSession(sessionId);
    }, 10000);
  };

  ws.onerror = () => setConnectionStatus('disconnected');
}

async function loadSessionViaREST(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return;
    const state = await res.json();
    updateSessionInfo(state);
    for (const t of state.transcripts) {
      addTranscriptLine(t);
    }
    updateSessionStatus({ status: state.status, endedAt: state.endedAt });
    if (state.hasDocument) {
      fetchAndRenderDocument(sessionId);
    }
    restLoaded = true;
  } catch { /* WS will handle it */ }
}

// --- Handlers --------------------------------------------------------------

function handleSessionState(state) {
  if (restLoaded) return;
  updateSessionInfo(state);

  for (const t of state.transcripts) {
    addTranscriptLine(t);
  }

  if (state.hasDocument) {
    fetchAndRenderDocument(state.id);
  }

  updateSessionStatus({ status: state.status, endedAt: state.endedAt });
}

function addTranscriptLine(entry) {
  const feed = $('#transcript-feed');
  const empty = feed.querySelector('.transcript-empty');
  if (empty) empty.remove();

  if (activeDeltaEl && activeDeltaEl.dataset.role === entry.role) {
    const textEl = activeDeltaEl.querySelector('.text');
    textEl.textContent = entry.text;
    const indicator = activeDeltaEl.querySelector('.streaming-indicator');
    if (indicator) indicator.remove();
    activeDeltaEl = null;
    return;
  }

  activeDeltaEl = null;

  const div = document.createElement('div');
  div.className = `transcript-line ${entry.role}`;

  const time = new Date(entry.timestamp).toLocaleTimeString();
  const roleLabels = { caller: 'CALLER', translation: 'TRANSLATION', system: 'SYSTEM' };
  const label = roleLabels[entry.role] || entry.role.toUpperCase();

  div.innerHTML = `
    <div class="meta">
      <span>${time}</span>
      <span>${label}</span>
    </div>
    <div class="text">${escapeHtml(entry.text)}</div>
  `;

  div.dataset.transcriptId = entry.id;
  feed.appendChild(div);

  if (autoScroll) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function correctTranscriptLine(data) {
  const el = document.querySelector(`[data-transcript-id="${data.id}"] .text`);
  if (el) el.textContent = data.text;
}

let activeDeltaEl = null;

function appendDelta(entry) {
  const feed = $('#transcript-feed');
  const empty = feed.querySelector('.transcript-empty');
  if (empty) empty.remove();

  if (!activeDeltaEl || activeDeltaEl.dataset.role !== entry.role) {
    activeDeltaEl = document.createElement('div');
    activeDeltaEl.className = `transcript-line ${entry.role}`;
    activeDeltaEl.dataset.role = entry.role;
    const deltaLabels = { caller: 'CALLER', translation: 'TRANSLATION', system: 'SYSTEM' };
    const label = deltaLabels[entry.role] || entry.role.toUpperCase();
    const time = new Date().toLocaleTimeString();
    activeDeltaEl.innerHTML = `
      <div class="meta">
        <span>${time}</span>
        <span>${label}</span>
        <span class="streaming-indicator">...</span>
      </div>
      <div class="text"></div>
    `;
    feed.appendChild(activeDeltaEl);
  }

  const textEl = activeDeltaEl.querySelector('.text');
  textEl.textContent += entry.delta;

  if (autoScroll) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function updateSessionStatus(data) {
  const dot = $('#status-dot');
  const label = $('#status-label');
  if (!dot || !label) return;

  dot.className = `status-dot ${data.status}`;
  label.textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);

  if (data.status === 'ended' || data.status === 'completed') {
    stopDurationTimer();
  }
}

function updateSessionInfo(state) {
  $('#session-id').textContent = state.id.slice(0, 8);
  const modeStr = state.mode === 'intake' ? 'INTAKE' : 'TRANSLATE';
  $('#session-mode').textContent = modeStr;
  $('#lang-pair').textContent = `${state.languagePair.a} \u2194 ${state.languagePair.b}`;
  $('#status-dot').className = `status-dot ${state.status}`;
  $('#status-label').textContent = state.status.charAt(0).toUpperCase() + state.status.slice(1);
  startDurationTimer(new Date(state.startedAt));
}

// --- Document rendering ----------------------------------------------------

async function fetchAndRenderDocument(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/document`);
    if (!res.ok) return;
    const doc = await res.json();
    renderDocument(doc);
  } catch (err) {
    showDocumentError(err.message);
  }
}

function renderDocument(doc) {
  const panel = $('#document-content');
  const s = doc.soapNote;

  let html = '<div class="soap-note">';

  if (doc.metadata?.disclaimer) {
    html += `<div class="disclaimer">${escapeHtml(doc.metadata.disclaimer)}</div>`;
  }

  html += renderSoapSection('Subjective', [
    field('Chief Complaint', s.subjective?.chiefComplaint),
    field('History of Present Illness', s.subjective?.historyOfPresentIllness),
    field('Medications', s.subjective?.medications),
    field('Allergies', s.subjective?.allergies),
    field('Past Medical History', s.subjective?.pastMedicalHistory),
    field('Review of Systems', s.subjective?.reviewOfSystems),
    field('Social History', s.subjective?.socialHistory),
    field('Family History', s.subjective?.familyHistory),
  ]);

  html += renderSoapSection('Assessment', [
    field('Summary', s.assessment?.summary),
    field('Differential Diagnosis', Array.isArray(s.assessment?.differentialDiagnosis)
      ? s.assessment.differentialDiagnosis.join(', ') : s.assessment?.differentialDiagnosis),
  ]);

  html += renderSoapSection('Plan', [
    field('Recommendations', Array.isArray(s.plan?.recommendations)
      ? s.plan.recommendations.map(r => `\u2022 ${r}`).join('<br>') : s.plan?.recommendations),
    field('Follow-up', s.plan?.followUp),
    field('Referrals', s.plan?.referrals),
  ]);

  if (doc.extractedEntities) {
    html += '<div class="soap-section"><h3>Extracted Entities</h3>';
    for (const [key, values] of Object.entries(doc.extractedEntities)) {
      if (Array.isArray(values) && values.length > 0) {
        html += `<div class="soap-field"><strong>${key}</strong><div class="entity-tags">`;
        html += values.map(v => `<span class="entity-tag">${escapeHtml(v)}</span>`).join('');
        html += '</div></div>';
      }
    }
    html += '</div>';
  }

  html += '</div>';
  panel.innerHTML = html;
}

function renderSoapSection(title, fields) {
  const validFields = fields.filter(f => f);
  if (validFields.length === 0) return '';
  return `<div class="soap-section"><h3>${title}</h3>${validFields.join('')}</div>`;
}

function field(label, value) {
  if (!value) return null;
  return `<div class="soap-field"><strong>${label}</strong><p>${value}</p></div>`;
}

function showDocumentError(error) {
  $('#document-content').innerHTML =
    `<div class="document-empty" style="color:var(--danger)">Document generation failed: ${escapeHtml(error)}</div>`;
}

function clearDocument() {
  $('#document-content').innerHTML =
    '<div class="document-empty">Medical note will appear here after the call ends.</div>';
}

// --- Duration timer --------------------------------------------------------

let durationInterval = null;

function startDurationTimer(startTime) {
  stopDurationTimer();
  const el = $('#duration');
  function update() {
    const diff = Math.floor((Date.now() - startTime.getTime()) / 1000);
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    el.textContent = `${m}:${s}`;
  }
  update();
  durationInterval = setInterval(update, 1000);
}

function stopDurationTimer() {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

// --- UI helpers ------------------------------------------------------------

function showNoSession() {
  $('#no-session').style.display = 'block';
  $('#session-view').style.display = 'none';
}

function showSessionView() {
  $('#no-session').style.display = 'none';
  $('#session-view').style.display = 'block';
}

function clearTranscript() {
  $('#transcript-feed').innerHTML =
    '<div class="transcript-empty">Waiting for speech...</div>';
}

function setConnectionStatus(status) {
  const el = $('#connection-status');
  el.className = `connection-status ${status}`;
  el.textContent = status === 'connected' ? 'Connected'
    : status === 'connecting' ? 'Connecting...'
    : 'Disconnected';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Scroll lock -----------------------------------------------------------

const feed = $('#transcript-feed');
if (feed) {
  feed.addEventListener('scroll', () => {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 50;
    autoScroll = atBottom;
  });
}

// --- Copy document ---------------------------------------------------------

function copyDocument() {
  const el = $('#document-content');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    const btn = $('#copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

// --- Config controls -------------------------------------------------------

function generateWebhookUrl() {
  const mode = $('#mode-select').value;
  const model = $('#model-select').value;
  const host = location.host;
  let url = `https://${host}/twilio/incoming-call?mode=${mode}`;
  if (model) url += `&model=${model}`;

  $('#webhook-url').textContent = url;
  $('#webhook-display').style.display = 'flex';
}

function copyWebhookUrl() {
  const url = $('#webhook-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $('#copy-url-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

async function runDemo() {
  const btn = $('#demo-btn');
  btn.textContent = 'Creating...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/demo', { method: 'POST' });
    const data = await res.json();
    await fetchSessions();
    $('#session-select').value = data.sessionId;
    await connectToSession(data.sessionId);
    btn.textContent = 'Run Demo';
  } catch (err) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Run Demo'; }, 2000);
  }
  btn.disabled = false;
}

$('#generate-url-btn')?.addEventListener('click', generateWebhookUrl);
$('#copy-url-btn')?.addEventListener('click', copyWebhookUrl);
$('#demo-btn')?.addEventListener('click', runDemo);

$('#mode-select')?.addEventListener('change', () => {
  const mode = $('#mode-select').value;
  const modelSelect = $('#model-select');
  if (mode === 'translator') {
    modelSelect.value = 'gpt-realtime-translate';
  } else {
    modelSelect.value = 'gpt-realtime-2';
  }
  if ($('#webhook-display').style.display !== 'none') generateWebhookUrl();
});

// --- Init ------------------------------------------------------------------

$('#session-select')?.addEventListener('change', (e) => {
  connectToSession(e.target.value);
});

$('#copy-btn')?.addEventListener('click', copyDocument);

$('#refresh-btn')?.addEventListener('click', fetchSessions);

setInterval(fetchSessions, 5000);

(async function init() {
  const sessions = await fetchSessions();
  const params = new URLSearchParams(location.search);
  const id = params.get('sessionId');
  if (id) {
    $('#session-select').value = id;
    await connectToSession(id);
  } else if (sessions.length > 0) {
    const active = sessions.find(s => s.status === 'active') || sessions[0];
    $('#session-select').value = active.id;
    await connectToSession(active.id);
  }
})();
