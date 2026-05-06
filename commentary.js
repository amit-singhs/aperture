(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const LS_PREFIX = 'aperture.creds.v2';
const COMMENTARY_SESSION_KEY = 'aperture.commentary.session.v1';
const COMMENTARY_LOCAL_PREFIX = 'aperture.commentary.feed.v1';
const MAX_EVENTS = 80;

let apiUrl = '';
let apiKey = '';
let sessionId = '';
let pollTimer = null;
let lastSeq = 0;
let channel = null;
const eventsByKey = new Map();
let events = [];

window.addEventListener('error', (ev) => {
  setStatus('error', 'page script error', `${ev.message || 'unknown error'}${ev.lineno ? ` at line ${ev.lineno}` : ''}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  setStatus('error', 'page promise error', ev.reason?.message || String(ev.reason || 'unknown promise error'));
});

function lsKey() { return `${LS_PREFIX}.describe`; }
function localFeedKey(session = sessionId) { return `${COMMENTARY_LOCAL_PREFIX}.${session}`; }
function cleanSession(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40); }
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function setStatus(stateName, text, detail) {
  const status = $('relayStatus');
  const detailEl = $('statusDetail');
  if (status) {
    status.dataset.state = stateName;
    status.textContent = text;
  }
  if (detailEl && detail) detailEl.textContent = detail;
}
function withApiKeyQuery(rawUrl) {
  const u = new URL(rawUrl, location.href);
  if (apiKey) u.searchParams.set('api_key', apiKey);
  return u.href;
}
function fetchHeaders() {
  // This header bypasses ngrok's browser warning page. It is safe for this POC.
  return { 'ngrok-skip-browser-warning': 'true' };
}
function loadInitial() {
  const params = new URLSearchParams(location.search);
  sessionId = cleanSession(params.get('session'));
  try {
    const creds = JSON.parse(localStorage.getItem(lsKey()) || '{}');
    $('apiUrl').value = creds.url || '';
    $('apiKey').value = creds.key || '';
    sessionId = sessionId || cleanSession(localStorage.getItem(COMMENTARY_SESSION_KEY));
  } catch (e) { /* ignore */ }
  $('sessionId').value = sessionId || '';
  $('sessionReadout').textContent = sessionId || '—';
}
function saveConfig() {
  apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  apiKey = $('apiKey').value.trim();
  sessionId = cleanSession($('sessionId').value.trim());
  $('sessionId').value = sessionId;
  $('sessionReadout').textContent = sessionId || '—';
  try {
    localStorage.setItem(lsKey(), JSON.stringify({ url: apiUrl, key: apiKey }));
    if (sessionId) localStorage.setItem(COMMENTARY_SESSION_KEY, sessionId);
  } catch (e) { /* ignore */ }
}
function setupChannel() {
  if (channel) channel.close();
  channel = null;
  if ('BroadcastChannel' in window && sessionId) {
    channel = new BroadcastChannel(`aperture-commentary-${sessionId}`);
    channel.onmessage = (ev) => addEvents([ev.data], 'browser');
  }
}
function eventKey(e) {
  return String(e.seq ?? e.id ?? e.request_id ?? `${e.created_at || e.server_ts || e.ts}-${String(e.description || '').slice(0, 20)}`);
}
function normalizeEvent(e) {
  if (!e) return null;
  const out = { ...e };
  out.session_id = out.session_id || sessionId;
  out.ts = out.ts || (out.created_at ? new Date(Number(out.created_at) * 1000).toISOString() : null) ||
           (out.server_ts ? new Date(Number(out.server_ts) * 1000).toISOString() : new Date().toISOString());
  out.source = out.source || out.source_type || 'webcam';
  out.capture_meta = out.capture_meta || out.captureMeta || null;
  return out;
}
function addEvents(newEvents, source) {
  let changed = false;
  for (const raw of newEvents || []) {
    const e = normalizeEvent(raw);
    if (!e || (e.session_id && e.session_id !== sessionId)) continue;
    const k = eventKey(e);
    if (eventsByKey.has(k)) continue;
    eventsByKey.set(k, true);
    events.push(e);
    if (Number.isFinite(Number(e.seq))) lastSeq = Math.max(lastSeq, Number(e.seq));
    changed = true;
  }
  if (!changed) return;
  events.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  render();
  setStatus('ok', source === 'backend' ? 'live via backend relay' : 'live locally', 'Receiving commentary events. Newest response appears at the top.');
}
function loadLocalEvents() {
  if (!sessionId) return;
  try {
    const arr = JSON.parse(localStorage.getItem(localFeedKey()) || '[]');
    addEvents(arr, 'browser');
  } catch (e) { /* ignore */ }
}
async function testBackendHealth() {
  if (!apiUrl) return false;
  const url = withApiKeyQuery(`${apiUrl}/health`);
  const r = await fetch(url, { headers: fetchHeaders(), cache: 'no-store' });
  if (!r.ok) throw new Error(`/health HTTP ${r.status}`);
  const text = await r.text();
  if (text.trim().startsWith('<')) throw new Error('ngrok/browser warning page returned instead of backend JSON');
  return true;
}
async function pollBackend() {
  if (!apiUrl || !sessionId) return;
  try {
    const url = new URL(`${apiUrl}/commentary/feed`);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('after', String(lastSeq || 0));
    if (apiKey) url.searchParams.set('api_key', apiKey);
    const r = await fetch(url.href, { headers: fetchHeaders(), cache: 'no-store' });
    if (r.status === 404) {
      setStatus('error', 'relay endpoint missing', 'Delete the old relay block, paste backend_commentary_relay_patch_v4.py into Colab, then restart the runtime/server.');
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.trim().startsWith('<')) throw new Error('ngrok/browser warning page returned instead of relay JSON');
    const d = JSON.parse(text);
    const incoming = d.events || d.items || [];
    addEvents(incoming, 'backend');
    if (Number.isFinite(Number(d.last_seq))) lastSeq = Math.max(lastSeq, Number(d.last_seq));
    if (!incoming.length && events.length === 0) {
      setStatus('ok', 'connected · waiting', 'Backend relay is reachable. Start the camera loop on the mobile page.');
    }
  } catch (e) {
    setStatus('error', 'relay not reachable', e.message || String(e));
  }
}
function startPolling() {
  stopPolling();
  setupChannel();
  loadLocalEvents();
  setStatus('ok', 'checking backend…', 'Testing /health before polling the relay.');
  testBackendHealth()
    .then(() => pollBackend())
    .catch((e) => setStatus('error', 'backend not reachable', e.message || String(e)));
  pollTimer = setInterval(() => {
    loadLocalEvents();
    pollBackend();
  }, 1500);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
function render() {
  $('feedCount').textContent = String(events.length);
  $('feedEmpty').style.display = events.length ? 'none' : '';
  $('feedList').innerHTML = events.map((e, i) => {
    const ts = e.ts ? new Date(e.ts) : null;
    const time = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleTimeString() : '—';
    const inf = e.inference_seconds != null ? `${Number(e.inference_seconds).toFixed(2)}s` : '—';
    const wait = e.queue_wait_seconds != null ? `${Number(e.queue_wait_seconds).toFixed(2)}s` : '—';
    const meta = e.capture_meta || {};
    const frame = meta.id ? `frame #${meta.id}` : (e.seq ? `seq ${e.seq}` : 'frame');
    const hash = meta.hash ? ` · h=${escapeHtml(meta.hash)}` : '';
    return `
      <article class="feed-item ${e.error ? 'error' : ''} ${i === 0 ? 'is-newest' : ''}">
        <div class="feed-meta">
          <span>${escapeHtml(time)}</span>
          <span>${escapeHtml(e.source || 'webcam')}</span>
          <span>${escapeHtml(frame)}${hash}</span>
          <span>inference ${escapeHtml(inf)}</span>
          <span>queue ${escapeHtml(wait)}</span>
        </div>
        <div class="description">${escapeHtml(e.description || '')}</div>
      </article>
    `;
  }).join('');
}

$('connectBtn').addEventListener('click', () => {
  saveConfig();
  if (!sessionId) {
    setStatus('error', 'missing session', 'Enter the same session code shown on the mobile camera page.');
    return;
  }
  if (!apiUrl) {
    setStatus('error', 'missing backend URL', 'Enter the ngrok backend URL.');
    return;
  }
  startPolling();
});
$('saveBtn').addEventListener('click', () => {
  saveConfig();
  setStatus('ok', 'saved', 'Configuration saved in this browser.');
});
$('clearBtn').addEventListener('click', () => {
  events = [];
  eventsByKey.clear();
  lastSeq = 0;
  try { localStorage.removeItem(localFeedKey()); } catch (e) { /* ignore */ }
  render();
});

loadInitial();
render();
if ($('apiUrl').value && $('sessionId').value) {
  saveConfig();
  startPolling();
}
})();
