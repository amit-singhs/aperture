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

function lsKey() { return `${LS_PREFIX}.describe`; }
function localFeedKey(session = sessionId) { return `${COMMENTARY_LOCAL_PREFIX}.${session}`; }
function cleanSession(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40); }
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function authHeaders() {
  const headers = {
    'ngrok-skip-browser-warning': 'true',
  };

  if (state.apiKey) {
    headers['X-API-Key'] = state.apiKey;
  }

  return headers;
}
function setStatus(state, text, detail) {
  $('relayStatus').dataset.state = state;
  $('relayStatus').textContent = text;
  if (detail) $('statusDetail').textContent = detail;
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
function eventKey(e) { return String(e.seq ?? e.id ?? `${e.ts}-${e.description?.slice(0, 20)}`); }
function addEvents(newEvents, source) {
  let changed = false;
  for (const e of newEvents || []) {
    if (!e || (e.session_id && e.session_id !== sessionId)) continue;
    const k = eventKey(e);
    if (eventsByKey.has(k)) continue;
    eventsByKey.set(k, true);
    events.push(e);
    if (Number.isFinite(Number(e.seq))) lastSeq = Math.max(lastSeq, Number(e.seq));
    changed = true;
  }
  if (!changed) return;
  events.sort((a, b) => new Date(b.ts || b.server_ts || 0) - new Date(a.ts || a.server_ts || 0));
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
async function pollBackend() {
  if (!apiUrl || !sessionId) return;
  try {
    const url = new URL(`${apiUrl}/commentary/feed`);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('after', String(lastSeq || 0));
    const r = await fetch(url.href, { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 404) {
      setStatus('error', 'relay endpoint missing', 'Use the v3 backend notebook or paste the commentary relay patch into your Colab backend.');
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    addEvents(d.events || [], 'backend');
    if (!(d.events || []).length && events.length === 0) {
      setStatus('ok', 'connected · waiting', 'Backend relay is reachable. Start the camera loop on the mobile page.');
    }
  } catch (e) {
    setStatus('error', 'relay not reachable', e.message);
  }
}
function startPolling() {
  stopPolling();
  setupChannel();
  loadLocalEvents();
  pollBackend();
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
  setStatus('ok', 'connecting…', 'Checking browser cache and backend relay.');
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
