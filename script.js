/* ============================================================
   APERTURE — Frontend behavior
   ============================================================ */

(() => {
'use strict';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DEFAULT_PROMPT =
  'Describe in detail what is happening in this image. Include people, ' +
  'their actions and expressions, objects, interactions, and the overall setting.';

const MAX_FEED = 10;
const STATS_POLL_MS = 5000;

// In ANPR mode, the slider's "seconds" value is overridden with this fast cadence.
// 600ms keeps overlays feeling live without flooding the backend or the GPU.
// (Lower if your backend has plenty of headroom; higher to reduce load.)
const ANPR_SAMPLE_INTERVAL_MS = 600;

// Mode-aware credential storage. Each mode keeps its own URL + key
// because they typically point at different Colab notebooks.
const LS_PREFIX = 'aperture.creds.v2';
const LS_MODE = 'aperture.mode.v1';
const MODES = ['describe', 'anpr'];

// Commentary display is now a separate page. The mobile sender publishes each
// completed /describe response to a named session; commentary.html reads it.
const COMMENTARY_SESSION_KEY = 'aperture.commentary.session.v1';
const COMMENTARY_LOCAL_PREFIX = 'aperture.commentary.feed.v1';
const COMMENTARY_MAX_LOCAL = 50;
const COMMENTARY_RELAY_ENDPOINT = '/commentary/publish';

// ---------- state ----------
const state = {
  mode: 'describe',   // 'describe' | 'anpr'
  apiUrl: '',
  apiKey: '',
  feed: [],            // descriptions, newest first, capped at MAX_FEED
  plates: [],          // unique plates this session, newest first (no cap)
  platesByKey: {},     // normalized plate text -> index in `plates`
  // Last-seen detections per source — used to redraw overlay when video moves
  lastDetections: { image: null, webcam: null, cctv: null },
  webcamStream: null,
  webcamLoopActive: false,
  webcamLoopTimer: null,
  webcamLoop: null,    // legacy
  cctvStream: null,
  cctvHls: null,
  cctvLoopActive: false,
  cctvLoopTimer: null,
  cctvLoop: null,
  selectedFile: null,
  selectedFileBitmap: null,  // ImageBitmap of last analyzed image, for overlay re-renders
  statsTimer: null,
  captureSeq: 0,
  commentarySession: null,
  commentaryChannel: null,
};

// ---------- creds ----------
function lsKey(mode) { return `${LS_PREFIX}.${mode}`; }

function loadCreds() {
  try {
    const v = localStorage.getItem(lsKey(state.mode));
    if (!v) {
      $('apiUrl').value = '';
      $('apiKey').value = '';
      return;
    }
    const { url, key } = JSON.parse(v);
    $('apiUrl').value = url || '';
    $('apiKey').value = key || '';
  } catch (e) { /* ignore */ }
}
function saveCreds() {
  try {
    localStorage.setItem(lsKey(state.mode), JSON.stringify({
      url: $('apiUrl').value.trim(),
      key: $('apiKey').value.trim(),
    }));
    flashHint(`saved for ${state.mode} mode`);
  } catch (e) {
    flashHint('could not save', 'error');
  }
}

function getApi() {
  state.apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  state.apiKey = $('apiKey').value.trim();
  return { url: state.apiUrl, key: state.apiKey };
}

function authHeaders() {
  const headers = {
    'ngrok-skip-browser-warning': 'true',
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  return headers;
}

function flashHint(msg, kind = 'info') {
  const el = $('connDetail');
  el.textContent = msg;
  el.style.color = kind === 'error' ? 'var(--error)'
                : kind === 'ok'    ? 'var(--accent)'
                                   : 'var(--text-mute)';
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}


// ---------- commentary display session / relay ----------
function makeSessionId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase() + '-' +
         Math.random().toString(36).slice(2, 7).toUpperCase();
}

function getCommentarySession() {
  if (state.commentarySession) return state.commentarySession;
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('session');
  let session = fromUrl || '';
  try {
    session = session || localStorage.getItem(COMMENTARY_SESSION_KEY) || '';
  } catch (e) { /* ignore */ }
  if (!session) session = makeSessionId();
  session = session.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || makeSessionId();
  state.commentarySession = session;
  try { localStorage.setItem(COMMENTARY_SESSION_KEY, session); } catch (e) { /* ignore */ }
  return session;
}

function commentaryLocalKey(session = getCommentarySession()) {
  return `${COMMENTARY_LOCAL_PREFIX}.${session}`;
}

function getCommentaryPageUrl() {
  const session = getCommentarySession();
  const url = new URL('commentary.html', location.href);
  url.searchParams.set('session', session);
  return url.href;
}

function initCommentarySenderUi() {
  const session = getCommentarySession();
  const codeEl = $('commentarySessionCode');
  const linkEl = $('commentaryOpenLink');
  const copyBtn = $('copyCommentaryLink');
  if (codeEl) codeEl.textContent = session;
  if (linkEl) linkEl.href = getCommentaryPageUrl();
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const url = getCommentaryPageUrl();
      try {
        await navigator.clipboard.writeText(url);
        flashHint('commentary page link copied', 'ok');
      } catch (e) {
        flashHint('copy failed — open commentary.html and enter this session code', 'error');
      }
    };
  }
  if ('BroadcastChannel' in window && !state.commentaryChannel) {
    state.commentaryChannel = new BroadcastChannel(`aperture-commentary-${session}`);
  }
}

function saveCommentaryEventLocal(event) {
  try {
    const key = commentaryLocalKey(event.session_id);
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.unshift(event);
    if (arr.length > COMMENTARY_MAX_LOCAL) arr.length = COMMENTARY_MAX_LOCAL;
    localStorage.setItem(key, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function publishCommentaryEvent(entry) {
  if (state.mode !== 'describe') return;
  const sessionId = getCommentarySession();
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: sessionId,
    ts: new Date().toISOString(),
    source: entry.source || 'frame',
    description: entry.description || '',
    error: !!entry.error,
    inference_seconds: entry.inference_seconds ?? null,
    queue_wait_seconds: entry.queue_wait_seconds ?? null,
    capture_meta: entry.captureMeta || null,
  };

  // Same-browser fallback. Useful while developing, but different devices need
  // the backend relay endpoints included in qwen_api_colab_v3_with_commentary_relay.ipynb.
  saveCommentaryEventLocal(event);
  try { state.commentaryChannel?.postMessage(event); } catch (e) { /* ignore */ }

  // Cross-device path: mobile publishes to backend, laptop polls the backend.
  if (state.apiUrl) {
    fetch(`${state.apiUrl}${COMMENTARY_RELAY_ENDPOINT}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      cache: 'no-store',
    }).catch(() => {
      // Older backend notebooks won't have this endpoint. The camera page still works;
      // commentary.html will show a clear relay warning until the backend patch is used.
    });
  }
}

// ---------- connection / health ----------
function setConnState(state, label) {
  const pill = $('connStatus');
  pill.dataset.state = state;
  pill.querySelector('.pill-label').textContent = label;
}

async function testConnection() {
  const { url } = getApi();
  if (!url) { flashHint('enter API URL first', 'error'); return; }

  setConnState('loading', 'connecting…');

  // Step 1: /health — this is the real "is the backend reachable" test.
  let healthData;
  try {
    const r = await fetch(`${url}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    healthData = await r.json();
  } catch (e) {
    setConnState('error', 'unreachable');
    flashHint(`error: ${e.message}`, 'error');
    stopStatsPolling();
    return;
  }

  // Health passed. Backend is reachable — pill is GREEN regardless of what /ready says.
  const gpuName = healthData.gpu?.name?.toLowerCase() || 'connected';
  setConnState('ok', gpuName);
  $('docsLink').href = `${url}/docs`;
  $('statBackend').textContent = gpuName;

  // Step 2: /ready — best-effort. Failure here means model still loading,
  // not that the connection is broken. Pill stays green.
  try {
    const r2 = await fetch(`${url}/ready`);
    if (r2.ok) {
      const d2 = await r2.json();
      const vramTotal = healthData.gpu?.vram_total_gb?.toFixed(0) ?? '?';
      flashHint(`ready · model ${d2.model_vram_gb.toFixed(1)} GB · ${vramTotal} GB total`, 'ok');
    } else {
      flashHint('connected · model still loading…', 'info');
    }
  } catch (e) {
    flashHint('connected · /ready endpoint not responding', 'info');
  }

  startStatsPolling();
}

// ---------- stats polling ----------
function startStatsPolling() {
  stopStatsPolling();
  pollStats();
  state.statsTimer = setInterval(pollStats, STATS_POLL_MS);
}
function stopStatsPolling() {
  if (state.statsTimer) { clearInterval(state.statsTimer); state.statsTimer = null; }
}
async function pollStats() {
  if (!state.apiUrl) return;
  try {
    const r = await fetch(`${state.apiUrl}/stats`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    // Connection is alive — make sure the pill reflects that.
    // (handles the case where it was previously in 'error' due to a transient failure)
    const pill = $('connStatus');
    if (pill.dataset.state !== 'ok') {
      const gpuName = $('statBackend').textContent || 'connected';
      setConnState('ok', gpuName);
    }

    $('statUptime').textContent = formatUptime(d.uptime_seconds);
    $('statRequests').textContent = `${d.requests_succeeded}/${d.requests_failed}`;
    $('statLatency').textContent = d.average_inference_seconds
      ? `${d.average_inference_seconds.toFixed(2)}s` : '—';
    $('statQueue').textContent = d.queue_depth ?? '—';
    if (d.vram_allocated_gb != null) {
      $('statVram').textContent = `${d.vram_allocated_gb.toFixed(1)} GB`;
    }
  } catch (e) {
    // Backend lost — flip the pill so the user knows
    setConnState('error', 'lost connection');
  }
}
function formatUptime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---------- feed (capped) ----------
function pushFeed(entry) {
  // entry: { description, source, inference_seconds, queue_wait_seconds, error, captureMeta }
  const fullEntry = { ...entry, ts: new Date() };
  state.feed.unshift(fullEntry);
  if (state.feed.length > MAX_FEED) {
    // explicit free of old entries — keeps memory flat for long sessions
    state.feed.length = MAX_FEED;
  }
  renderFeed();
  publishCommentaryEvent(fullEntry);
}

function renderFeed() {
  const list = $('feedList');
  const empty = $('feedEmpty');
  $('feedCount').textContent = state.feed.length;

  if (state.feed.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Render fully each time to keep DOM aligned with capped state.
  list.innerHTML = state.feed.map((e, i) => {
    const isNewest = i === 0;
    const time = e.ts.toTimeString().slice(0, 8);
    const src = (e.source || 'frame').toLowerCase();
    const cls = e.error ? 'src-error' : `src-${src}`;
    const newestCls = isNewest ? ' is-newest' : '';
    const body = escapeHtml(e.description);
    const inf = e.inference_seconds != null ? `${e.inference_seconds.toFixed(2)}s` : '—';
    const wait = e.queue_wait_seconds != null && e.queue_wait_seconds > 0.01
                  ? `· queued ${e.queue_wait_seconds.toFixed(2)}s` : '';
    const cap = e.captureMeta ? formatCaptureMeta(e.captureMeta) : '';
    return `
      <article class="feed-item ${cls}${newestCls}">
        <header class="feed-item-head">
          <span class="feed-item-time">${time}</span>
          <span class="feed-item-source">${e.error ? 'error' : src}</span>
        </header>
        <div class="feed-item-body">${body}</div>
        ${e.error ? (cap ? `<footer class="feed-item-foot"><span>${cap}</span></footer>` : '') : `
        <footer class="feed-item-foot">
          <span><span class="stat-key">inference</span> <span class="stat-val">${inf}</span></span>
          ${wait ? `<span><span class="stat-key">${wait}</span></span>` : ''}
          ${cap ? `<span>${cap}</span>` : ''}
        </footer>`}
      </article>
    `;
  }).join('');
}

function formatCaptureMeta(meta) {
  if (!meta) return '';
  const sent = meta.capturedAt ? new Date(meta.capturedAt).toTimeString().slice(0, 8) : '—';
  const vf = meta.presentedFrames != null ? ` · vf ${meta.presentedFrames}` : '';
  const timeout = meta.frameTimedOut ? ' · wait timeout' : '';
  return `<span class="stat-key">frame</span> <span class="stat-val">#${meta.id}</span> · ${escapeHtml(meta.hash)} · sent ${sent} · video ${Number(meta.videoTime || 0).toFixed(2)}s${vf}${timeout}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

$('clearFeed').onclick = () => { state.feed = []; renderFeed(); };

// ============================================================
// ANPR — overlay drawing & plate dedup
// ============================================================

// Source -> {video element, overlay canvas, anchor element for sizing}
function getOverlayTargets(sourceLabel) {
  if (sourceLabel === 'webcam' || sourceLabel === 'webcam-loop') {
    return {
      media: $('webcamVideo'),
      overlay: $('webcamOverlay2'),
      // The overlay is sized to the .video-frame parent
    };
  }
  if (sourceLabel === 'cctv') {
    return { media: $('cctvVideo'), overlay: $('cctvOverlay2') };
  }
  if (sourceLabel === 'image' || sourceLabel === 'file') {
    return { media: $('imagePreview'), overlay: $('imageOverlay2') };
  }
  return { media: null, overlay: null };
}

// Draw the bounding boxes for a given source onto its overlay canvas.
// `result` comes straight from /detect, with absolute pixel coords relative
// to the original sent frame.
//
// Design note: for the image source, the displayed <img> may not fill the
// dropzone (object-fit: contain + max-height). To get boxes in the right
// place we resize+reposition the canvas to match the rendered image rect.
// For video, the overlay covers the whole .video-frame (which the video
// also fills via object-fit: contain), so we use computeContainRect there.
function drawOverlayForSource(sourceLabel, result) {
  const { media, overlay } = getOverlayTargets(sourceLabel);
  if (!media || !overlay) return;
  if (state.mode !== 'anpr') return;

  // For image source, sync the canvas position+size to the <img>'s actual
  // rendered rectangle (post object-fit). This is the only way to get pixel
  // coordinates aligned to the visible image rather than to its container.
  let cssW, cssH;
  if (sourceLabel === 'image' || sourceLabel === 'file') {
    const img = media; // <img id="imagePreview">
    if (img.hidden || !img.naturalWidth) {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    // The displayed rect of the <img> within its parent (.dropzone)
    const rect = img.getBoundingClientRect();
    const parentRect = overlay.parentElement.getBoundingClientRect();
    overlay.style.left = `${rect.left - parentRect.left}px`;
    overlay.style.top = `${rect.top - parentRect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
  } else {
    // For video sources, overlay covers the whole .video-frame which the
    // video also fills via object-fit: contain. Computing the contain rect
    // inside drawing handles letterboxing of the video frame.
    overlay.style.left = '';
    overlay.style.top = '';
    overlay.style.width = '';
    overlay.style.height = '';
    const rect = overlay.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
  }

  // Match canvas pixel size to its CSS size (1 canvas px = 1 CSS px)
  if (overlay.width !== cssW) overlay.width = cssW;
  if (overlay.height !== cssH) overlay.height = cssH;

  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, cssW, cssH);

  if (!result || !result.detections || !result.detections.length) return;

  // For image: overlay is now exactly the size of the rendered <img>, so the
  // mapping is a simple scale from the original image dimensions to display.
  // For video: overlay covers the .video-frame; the video inside is letterboxed
  // via object-fit, so we need computeContainRect to place boxes correctly.
  let mediaRect;
  if (sourceLabel === 'image' || sourceLabel === 'file') {
    mediaRect = { x: 0, y: 0, w: cssW, h: cssH };
  } else {
    mediaRect = computeContainRect(
      result.image_width, result.image_height, cssW, cssH
    );
  }

  const sx = mediaRect.w / result.image_width;
  const sy = mediaRect.h / result.image_height;

  ctx.lineWidth = 2;
  ctx.font = '600 14px "Geist Mono", ui-monospace, monospace';
  ctx.textBaseline = 'bottom';

  for (const det of result.detections) {
    const [x1, y1, x2, y2] = det.box;
    const dx = mediaRect.x + x1 * sx;
    const dy = mediaRect.y + y1 * sy;
    const dw = (x2 - x1) * sx;
    const dh = (y2 - y1) * sy;

    // "Locking on" visual: faint/animated while gathering OCR votes,
    // solid + bright once we have consensus text.
    const hasConsensus = !!det.plate_text;
    const accentColor = '#5eead4';
    const dimColor = 'rgba(94, 234, 212, 0.45)';

    if (hasConsensus) {
      // Solid box, bright corners, label
      ctx.strokeStyle = accentColor;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 4;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh);
      ctx.shadowBlur = 0;

      const bracketLen = Math.min(14, Math.max(6, dw * 0.15));
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      drawCornerBrackets(ctx, dx, dy, dw, dh, bracketLen);
      ctx.lineWidth = 2;

      // Label
      const conf = (det.ocr_confidence != null ? det.ocr_confidence : det.confidence) * 100;
      const label = `${det.plate_text}  ·  ${conf.toFixed(0)}%`;
      const padding = 6;
      const metrics = ctx.measureText(label);
      const labelW = metrics.width + padding * 2;
      const labelH = 22;
      const labelY = dy >= labelH ? dy - 2 : dy + labelH + 2;
      ctx.fillStyle = 'rgba(8, 9, 12, 0.92)';
      ctx.fillRect(dx, labelY - labelH, labelW, labelH);
      ctx.fillStyle = accentColor;
      ctx.fillText(label, dx + padding, labelY - 5);
    } else {
      // Searching: dashed dim outline + corner brackets only, no label
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = dimColor;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh);
      ctx.setLineDash([]);

      const bracketLen = Math.min(14, Math.max(6, dw * 0.15));
      ctx.strokeStyle = dimColor;
      ctx.lineWidth = 3;
      drawCornerBrackets(ctx, dx, dy, dw, dh, bracketLen);
      ctx.lineWidth = 2;

      // Vote count indicator (small, top-right of box) so the user can
      // see that the system IS working — just gathering more reads.
      if (det.vote_count !== undefined && det.vote_count > 0) {
        ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
        ctx.fillStyle = dimColor;
        ctx.textBaseline = 'top';
        ctx.fillText(`reading ${det.vote_count}/2`, dx + 4, dy + 4);
        ctx.font = '600 14px "Geist Mono", ui-monospace, monospace';
        ctx.textBaseline = 'bottom';
      }
    }
  }
}

function drawCornerBrackets(ctx, x, y, w, h, len) {
  // top-left
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.stroke();
  // top-right
  ctx.beginPath();
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.stroke();
  // bottom-left
  ctx.beginPath();
  ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
  ctx.stroke();
  // bottom-right
  ctx.beginPath();
  ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len);
  ctx.stroke();
}

// Compute the letterboxed rectangle of an `imgW x imgH` image fitted into
// a `boxW x boxH` container with object-fit: contain.
function computeContainRect(imgW, imgH, boxW, boxH) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  const x = (boxW - w) / 2;
  const y = (boxH - h) / 2;
  return { x, y, w, h };
}

// ---- plate dedup ----

// OCR confusions — folded for fuzzy matching
const OCR_CONFUSIONS = {
  '0': 'O', 'O': 'O',
  '1': 'I', 'I': 'I', 'L': 'I',
  '5': 'S', 'S': 'S',
  '8': 'B', 'B': 'B',
  '2': 'Z', 'Z': 'Z',
};

// Normalize a plate string for fuzzy comparison. Strips non-alphanumerics,
// uppercases, and folds common OCR confusions.
function normalizePlate(s) {
  if (!s) return '';
  const upper = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let out = '';
  for (const ch of upper) {
    out += OCR_CONFUSIONS[ch] || ch;
  }
  return out;
}

// Levenshtein distance — small implementation, fine for plate lengths (≤12 chars)
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Find the closest existing plate within a small edit-distance threshold.
// Returns the matched key, or null.
function findFuzzyMatch(normalizedNew) {
  const keys = Object.keys(state.platesByKey);
  if (keys.length === 0) return null;
  // Quick path: exact match
  if (state.platesByKey[normalizedNew] !== undefined) return normalizedNew;
  // Tolerance scales with plate length — for typical 6-10 char plates, allow 1-2 substitutions
  const tolerance = normalizedNew.length >= 6 ? 2 : 1;
  for (const k of keys) {
    if (Math.abs(k.length - normalizedNew.length) > tolerance) continue;
    if (editDistance(k, normalizedNew) <= tolerance) return k;
  }
  return null;
}

function addOrUpdatePlate(det, frameBlob, result, sourceLabel) {
  // For video sources we want at least 2 votes before logging (single-frame
  // OCR is too noisy). For still images there's only one frame so accept it
  // immediately — the UI also lets the user re-analyze the same image.
  const isStillImage = sourceLabel === 'image' || sourceLabel === 'file';
  if (!det.plate_text) return;
  if (!isStillImage && det.vote_count !== undefined && det.vote_count < 2) {
    return;
  }

  const normalized = normalizePlate(det.plate_text);
  if (!normalized || normalized.length < 3) return;

  // Primary: match by tracker ID (backend-assigned, stable across frames)
  // Secondary: fuzzy match on text (handles tracker death + respawn for same plate)
  let matchedIdx = -1;
  if (det.plate_id) {
    matchedIdx = state.plates.findIndex((p) => p.plate_id === det.plate_id);
  }
  if (matchedIdx === -1) {
    const fuzzyKey = findFuzzyMatch(normalized);
    if (fuzzyKey !== null) {
      matchedIdx = state.plates.findIndex((p) => p.key === fuzzyKey);
    }
  }

  if (matchedIdx === -1) {
    // New plate
    cropPlateThumb(frameBlob, det.box, result.image_width, result.image_height)
      .then((thumbUrl) => {
        const entry = {
          key: normalized,
          plate_id: det.plate_id || null,
          text: det.plate_text,
          confidence: det.confidence,
          ocr_confidence: det.ocr_confidence ?? 0,
          firstSeen: new Date(),
          thumbUrl,
        };
        state.plates.unshift(entry);
        state.platesByKey[normalized] = 0;
        renderPlates();
      });
  } else {
    // Existing plate — update if better confidence, attach plate_id if new
    const existing = state.plates[matchedIdx];
    if (det.plate_id && !existing.plate_id) {
      existing.plate_id = det.plate_id;
    }
    const newConf = det.ocr_confidence ?? 0;
    if (newConf > (existing.ocr_confidence ?? 0)) {
      existing.text = det.plate_text;
      existing.ocr_confidence = newConf;
      existing.confidence = det.confidence;
      cropPlateThumb(frameBlob, det.box, result.image_width, result.image_height)
        .then((thumbUrl) => {
          if (existing.thumbUrl) URL.revokeObjectURL(existing.thumbUrl);
          existing.thumbUrl = thumbUrl;
          renderPlates();
        });
    }
  }
}

// Crop a plate region out of a frame blob and return a blob URL for the thumbnail
async function cropPlateThumb(frameBlob, box, imgW, imgH) {
  try {
    const bitmap = await createImageBitmap(frameBlob);
    const [x1, y1, x2, y2] = box;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, x1, y1, w, h, 0, 0, w, h);
    bitmap.close?.();
    return await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.85);
    });
  } catch (e) {
    return '';
  }
}

function renderPlates() {
  const list = $('platesList');
  const empty = $('platesEmpty');
  $('platesCount').textContent = state.plates.length;

  if (state.plates.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = state.plates.map((p, i) => {
    const time = p.firstSeen.toTimeString().slice(0, 8);
    const conf = ((p.ocr_confidence ?? 0) * 100).toFixed(0);
    const newestCls = i === 0 ? ' is-newest' : '';
    const thumb = p.thumbUrl
      ? `<div class="plate-thumb"><img src="${p.thumbUrl}" alt=""></div>`
      : `<div class="plate-thumb"></div>`;
    return `
      <div class="plate-item${newestCls}">
        ${thumb}
        <div class="plate-info">
          <div class="plate-text">${escapeHtml(p.text)}</div>
          <div class="plate-meta">
            <span class="plate-meta-time">first seen ${time}</span>
            <span class="plate-meta-conf">ocr ${conf}%</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function clearPlates() {
  // Free thumbnail blob URLs
  for (const p of state.plates) {
    if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  }
  state.plates = [];
  state.platesByKey = {};
  renderPlates();
}

// Re-render overlays on layout changes (window resize, mode switch, etc.)
function redrawAllOverlays() {
  for (const source of ['image', 'webcam', 'cctv']) {
    const result = state.lastDetections[source];
    if (result) drawOverlayForSource(source, result);
  }
}
window.addEventListener('resize', redrawAllOverlays);

// Continuous overlay redraw — keeps boxes correctly positioned even when
// underlying media element is resized by something we don't observe (e.g.
// orientation change, scroll, video metadata updating dimensions).
function startOverlayLoop() {
  function frame() {
    if (state.mode === 'anpr') {
      redrawAllOverlays();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- core: send a frame ----------
async function sendFrame(blob, sourceLabel, prompt) {
  if (!state.apiUrl) {
    flashHint('configure backend connection first', 'error');
    return;
  }

  if (state.mode === 'anpr') {
    return sendFrameAnpr(blob, sourceLabel);
  }
  return sendFrameDescribe(blob, sourceLabel, prompt);
}

async function sendFrameDescribe(blob, sourceLabel, prompt) {
  const meta = blob?._apertureMeta || null;
  const fd = new FormData();
  const filename = meta ? `frame-${meta.id}-${meta.hash}.jpg` : 'frame.jpg';
  fd.append('image', blob, filename);
  fd.append('prompt', prompt || DEFAULT_PROMPT);
  fd.append('source_type', sourceLabel || 'frame');
  // Use a unique source_id per commentary request. This prevents any backend,
  // proxy, or source-session cache from accidentally reusing a previous frame.
  fd.append('source_id', meta ? `aperture-${sourceLabel || 'frame'}-${meta.id}-${meta.hash}` : `aperture-${Date.now()}`);

  try {
    const r = await fetch(`${state.apiUrl}/describe?capture=${encodeURIComponent(meta?.id || Date.now())}`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
      cache: 'no-store',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      updateDiagResult(meta, false, d.detail || `HTTP ${r.status}`);
      pushFeed({
        description: d.detail || `HTTP ${r.status}`,
        source: sourceLabel,
        error: true,
        captureMeta: meta,
      });
      return;
    }
    updateDiagResult(meta, true, d);
    pushFeed({
      description: d.description,
      source: sourceLabel,
      inference_seconds: d.inference_seconds,
      queue_wait_seconds: d.queue_wait_seconds,
      captureMeta: meta,
    });
  } catch (e) {
    updateDiagResult(meta, false, e.message);
    pushFeed({ description: `network error · ${e.message}`, source: sourceLabel, error: true, captureMeta: meta });
  }
}

async function sendFrameAnpr(blob, sourceLabel) {
  const fd = new FormData();
  fd.append('image', blob, 'frame.jpg');
  fd.append('run_ocr', 'true');
  if (window.APERTURE_DEBUG_ANPR) {
    fd.append('debug', 'true');
  }
  fd.append('source_type', sourceLabel || 'frame');
  // For still images, use a unique source_id per analysis so each image is
  // processed with a fresh tracker state. For video sources, all frames in
  // the stream share one source_id so trackers persist across frames.
  const sourceId = (sourceLabel === 'image' || sourceLabel === 'file')
    ? `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : `aperture-${sourceLabel || 'default'}`;
  fd.append('source_id', sourceId);

  try {
    const r = await fetch(`${state.apiUrl}/detect`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn('[anpr] error:', d.detail || r.status, d);
      flashHint(`detect error: ${d.detail || r.status}`, 'error');
      return;
    }
    if (window.APERTURE_DEBUG_ANPR) {
      console.log(`[anpr] ${d.detections?.length ?? 0} detections in ${d.inference_seconds}s`, d);
    }
    handleDetectionResult(d, sourceLabel, blob);
  } catch (e) {
    console.error('[anpr] network error:', e);
    flashHint(`network error: ${e.message}`, 'error');
  }
}

function handleDetectionResult(result, sourceLabel, frameBlob) {
  // Cache the raw detections for this source so we can re-render on resize
  state.lastDetections[sourceLabel] = result;
  drawOverlayForSource(sourceLabel, result);

  // For each detection that has a plate_text, attempt to dedupe and add to log
  for (const det of result.detections || []) {
    if (!det.plate_text) continue;
    addOrUpdatePlate(det, frameBlob, result, sourceLabel);
  }
}

/* ============================================================
   Frame capture — Android-safe fresh-frame version
   ============================================================
   Important change for mobile browsers:
   - For WEBCAM commentary we no longer use ImageCapture.grabFrame().
     The sent JPEG is drawn from the live <video> element only after the
     browser reports a newly presented video frame.
   - requestVideoFrameCallback is used when available; it is designed for
     per-video-frame work and gives presentedFrames/mediaTime metadata.
   - Fallback is requestAnimationFrame + a short delay, so Firefox Android
     still works.
   - Every outgoing blob receives local metadata: capture id, wall-clock time,
     video time, dimensions, byte size, and a tiny sampled frame hash.

   Public flag: window.APERTURE_DEBUG_CAPTURE = true — prints diagnostics. */

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function debugCapture(...args) {
  if (window.APERTURE_DEBUG_CAPTURE) {
    console.log('[capture]', ...args);
  }
}

// Legacy no-op kept so older stop/flip code paths do not break.
function clearImageCaptureCache() {}

const _lastFrameMarker = new WeakMap();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureVideoPlaying(videoEl) {
  if (!videoEl) return;
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  if (videoEl.paused || videoEl.ended) {
    try {
      await videoEl.play();
      debugCapture('video.play() resolved, paused=', videoEl.paused);
    } catch (e) {
      debugCapture('video.play() failed:', e.message);
    }
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      debugCapture(`timeout: ${label} (${ms}ms)`);
      resolve({ timedOut: true, label });
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); debugCapture(`error in ${label}:`, e.message); resolve({ error: e.message, label }); }
    );
  });
}

function frameMarkerFromMeta(videoEl, meta) {
  if (meta && Number.isFinite(meta.presentedFrames)) {
    return `${meta.presentedFrames}:${Number(meta.mediaTime || 0).toFixed(4)}`;
  }
  return `time:${Number(videoEl.currentTime || 0).toFixed(4)}:${performance.now().toFixed(1)}`;
}

function waitForNextPresentedFrame(videoEl, timeoutMs = 1200) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
    return Promise.resolve({ method: 'not-ready', timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let callbackId = null;
    let timerId = null;
    const prev = _lastFrameMarker.get(videoEl);

    function finish(info) {
      if (settled) return;
      settled = true;
      if (timerId) clearTimeout(timerId);
      if (callbackId != null && typeof videoEl.cancelVideoFrameCallback === 'function') {
        try { videoEl.cancelVideoFrameCallback(callbackId); } catch (e) { /* ignore */ }
      }
      resolve(info);
    }

    timerId = setTimeout(() => {
      debugCapture(`timeout: fresh video frame (${timeoutMs}ms)`);
      finish({ method: 'timeout', timedOut: true, marker: prev || '' });
    }, timeoutMs);

    // Chrome Android and modern Firefox expose this. It is the cleanest signal
    // that a new camera frame reached the compositor.
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      const onFrame = (_now, meta) => {
        if (settled) return;
        const marker = frameMarkerFromMeta(videoEl, meta);
        if (!prev || marker !== prev) {
          _lastFrameMarker.set(videoEl, marker);
          finish({
            method: 'requestVideoFrameCallback',
            marker,
            presentedFrames: meta.presentedFrames,
            mediaTime: meta.mediaTime,
            expectedDisplayTime: meta.expectedDisplayTime,
            timedOut: false,
          });
          return;
        }
        callbackId = videoEl.requestVideoFrameCallback(onFrame);
      };
      callbackId = videoEl.requestVideoFrameCallback(onFrame);
      return;
    }

    // Firefox/older-browser fallback: let the browser paint once, then draw.
    const startTime = Number(videoEl.currentTime || 0);
    const startedAt = performance.now();
    const step = () => {
      if (settled) return;
      const nowTime = Number(videoEl.currentTime || 0);
      if (nowTime !== startTime || performance.now() - startedAt > 180) {
        const marker = `raf:${nowTime.toFixed(4)}:${performance.now().toFixed(1)}`;
        _lastFrameMarker.set(videoEl, marker);
        finish({ method: 'requestAnimationFrame', marker, mediaTime: nowTime, timedOut: false });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function sampleCanvasHash(ctx, w, h) {
  // Lightweight visual fingerprint. Not cryptographic; it only tells us whether
  // the sent pixels are changing across captures.
  try {
    let hash = 2166136261; // FNV-ish
    const xs = [0.12, 0.28, 0.44, 0.60, 0.76, 0.92];
    const ys = [0.18, 0.34, 0.50, 0.66, 0.82];
    for (const yy of ys) {
      for (const xx of xs) {
        const x = Math.min(w - 1, Math.max(0, Math.floor(w * xx)));
        const y = Math.min(h - 1, Math.max(0, Math.floor(h * yy)));
        const data = ctx.getImageData(x, y, 1, 1).data;
        for (let i = 0; i < 3; i++) {
          hash ^= data[i];
          hash = Math.imul(hash, 16777619) >>> 0;
        }
      }
    }
    return hash.toString(16).padStart(8, '0');
  } catch (e) {
    return 'nohash';
  }
}

function annotateCaptureBlob(blob, meta) {
  if (!blob) return blob;
  try { blob._apertureMeta = meta; } catch (e) { /* Blob may be non-extensible in unusual browsers */ }
  return blob;
}

function drawAndEncode(videoEl, quality = 0.85, frameInfo = {}) {
  return new Promise((resolve) => {
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (!w || !h) {
      debugCapture('drawAndEncode: zero dimensions, returning null');
      resolve(null);
      return;
    }

    const canvas = $('frameCanvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);

    // The crucial line: capture the actual currently presented video frame.
    ctx.drawImage(videoEl, 0, 0, w, h);

    const hash = sampleCanvasHash(ctx, w, h);
    const id = ++state.captureSeq;
    const meta = {
      id,
      hash,
      width: w,
      height: h,
      capturedAt: Date.now(),
      videoTime: Number(videoEl.currentTime || 0),
      frameMethod: frameInfo.method || 'drawImage',
      frameMarker: frameInfo.marker || '',
      presentedFrames: frameInfo.presentedFrames ?? null,
      frameTimedOut: !!frameInfo.timedOut,
      source: videoEl.id || 'video',
    };

    canvas.toBlob((b) => {
      if (b) meta.sizeBytes = b.size;
      debugCapture(
        `capture #${meta.id}: ${w}x${h}, ${(b?.size || 0)} bytes, hash=${hash}, ` +
        `videoTime=${meta.videoTime.toFixed(3)}, method=${meta.frameMethod}, timedOut=${meta.frameTimedOut}`
      );
      resolve(annotateCaptureBlob(b, meta));
    }, 'image/jpeg', quality);
  });
}

async function captureFrame(videoEl, stream, quality = 0.85) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
    debugCapture('captureFrame: video has no dimensions');
    return null;
  }

  await ensureVideoPlaying(videoEl);

  let frameInfo = await waitForNextPresentedFrame(videoEl, 1200);

  // If Android pauses compositor callbacks while the page is being touched or
  // the browser is busy, kick playback once and wait briefly again. This avoids
  // the old first-frame loop without hanging the sender.
  if (frameInfo && frameInfo.timedOut) {
    debugCapture('fresh frame wait timed out; nudging video.play() and retrying once');
    await ensureVideoPlaying(videoEl);
    await sleep(120);
    const retry = await waitForNextPresentedFrame(videoEl, 700);
    if (retry && !retry.timedOut) frameInfo = retry;
  }

  return await withTimeout(drawAndEncode(videoEl, quality, frameInfo || {}), 2200, 'drawAndEncode');
}

// ============================================================
// TABS
// ============================================================
function initTabs() {
  const tabs = $$('.tab');
  const rail = $('tabRail');

  function activate(targetId, animate = true) {
    tabs.forEach(t => {
      const isActive = t.dataset.tab === targetId;
      t.classList.toggle('is-active', isActive);
      t.setAttribute('aria-selected', isActive);
    });
    $$('.tabpanel').forEach(p => {
      const isActive = p.dataset.panel === targetId;
      p.classList.toggle('is-active', isActive);
      p.hidden = !isActive;
    });
    moveRail(animate);
  }

  function moveRail() {
    const active = $$('.tab').find(t => t.classList.contains('is-active'));
    if (!active) return;
    rail.style.left = `${active.offsetLeft}px`;
    rail.style.width = `${active.offsetWidth}px`;
  }

  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));
  window.addEventListener('resize', moveRail);
  // Initial position after layout settles
  requestAnimationFrame(() => requestAnimationFrame(moveRail));
}

// ============================================================
// CONFIG TOGGLE
// ============================================================
$('configToggle').onclick = () => {
  const t = $('configToggle');
  const expanded = t.getAttribute('aria-expanded') === 'true';
  t.setAttribute('aria-expanded', String(!expanded));
};

// ============================================================
// IMAGE TAB
// ============================================================
function initImageTab() {
  const dz = $('dropZone');
  const input = $('fileInput');
  const preview = $('imagePreview');
  const empty = $('dropEmpty');
  const analyzeBtn = $('analyzeImage');
  const clearBtn = $('clearImage');

  $('promptImage').value = DEFAULT_PROMPT;

  function pickFile(f) {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      flashHint('please select an image file', 'error');
      return;
    }
    state.selectedFile = f;
    preview.src = URL.createObjectURL(f);
    preview.hidden = false;
    empty.style.display = 'none';
    analyzeBtn.disabled = false;
    clearBtn.disabled = false;

    // When the image finishes loading, re-position the overlay so any
    // existing detections render in the right place. This also runs after
    // window resize / orientation change since the rect changes.
    preview.onload = () => {
      if (state.lastDetections.image) {
        drawOverlayForSource('image', state.lastDetections.image);
      }
    };
  }

  input.addEventListener('change', e => pickFile(e.target.files[0]));

  // Drag & drop
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    pickFile(f);
  });

  analyzeBtn.onclick = async () => {
    if (!state.selectedFile) return;
    analyzeBtn.disabled = true;
    const wasText = analyzeBtn.querySelector('span:last-child').textContent;
    analyzeBtn.querySelector('span:last-child').textContent = 'analyzing…';
    await sendFrame(state.selectedFile, 'image', $('promptImage').value);
    analyzeBtn.querySelector('span:last-child').textContent = wasText;
    analyzeBtn.disabled = false;
  };

  clearBtn.onclick = () => {
    state.selectedFile = null;
    preview.hidden = true;
    preview.src = '';
    empty.style.display = '';
    input.value = '';
    analyzeBtn.disabled = true;
    clearBtn.disabled = true;
    // Clear any ANPR overlay/cached detection for this source
    state.lastDetections.image = null;
    const overlay = $('imageOverlay2');
    if (overlay) {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  };
}


function formatIntervalSeconds(sec) {
  sec = Math.max(0, Number(sec || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function clampDescribeIntervalSeconds(raw) {
  return Math.max(15, Math.min(300, parseInt(raw, 10) || 15));
}

// ============================================================
// WEBCAM TAB
// ============================================================
function initWebcamTab() {
  const video = $('webcamVideo');
  const empty = $('webcamEmpty');
  const overlay = $('webcamOverlay');
  const startBtn = $('startWebcam');
  const stopBtn = $('stopWebcam');
  const captureBtn = $('captureOnce');
  const loopBtn = $('webcamLoopToggle');
  const intervalSlider = $('webcamInterval');
  const intervalLabel = $('webcamIntervalLabel');
  const intervalDisplay = $('webcamIntervalDisplay');
  const facing = $('webcamFacing');
  const flipBtn = $('flipCamera');

  $('promptWebcam').value = DEFAULT_PROMPT;

  // Track whether the active stream is producing usable frames.
  // 'videoWidth > 0' is the canonical "ready to draw to canvas" signal.
  let videoReady = false;

  function refreshWebcamIntervalLabel() {
    const sec = clampDescribeIntervalSeconds(intervalSlider.value);
    intervalSlider.value = String(sec);
    intervalLabel.textContent = formatIntervalSeconds(sec);
    intervalDisplay.textContent = formatIntervalSeconds(sec);
  }
  intervalSlider.addEventListener('input', refreshWebcamIntervalLabel);
  refreshWebcamIntervalLabel();

  // ---- camera open helper ----
  // Tries facing-mode preference, then falls back. iOS Safari sometimes ignores
  // a soft 'environment' hint and gives the front cam — using `exact` is the fix.
  async function openCamera(preferredFacing) {
    const constraints = [
      { video: { facingMode: { exact: preferredFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: preferredFacing,            width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: preferredFacing }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of constraints) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('could not open camera');
  }

  // Wait until the video element has real dimensions. Without this on mobile,
  // capture-to-canvas produces a 0×0 image and the API returns 'empty payload'.
  function waitForVideoReady(videoEl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        resolve(); return;
      }
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (e) => {
        cleanup();
        reject(new Error('video element error'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('video metadata timeout'));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        videoEl.removeEventListener('loadedmetadata', onReady);
        videoEl.removeEventListener('canplay', onReady);
        videoEl.removeEventListener('error', onError);
      }
      videoEl.addEventListener('loadedmetadata', onReady);
      videoEl.addEventListener('canplay', onReady);
      videoEl.addEventListener('error', onError);
    });
  }

  async function startCamera() {
    videoReady = false;
    captureBtn.disabled = true;
    loopBtn.disabled = true;
    startBtn.disabled = true;
    flipBtn.disabled = true;

    try {
      const stream = await openCamera(facing.value);
      state.webcamStream = stream;

      // iOS-specific: enforce playsinline at runtime too. Without this,
      // tapping play would full-screen the video on some iOS versions.
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;

      video.srcObject = stream;

      // iOS specifically requires play() to be awaited in response to a user gesture.
      // We're inside an onclick handler so this is the right time.
      try {
        await video.play();
        debugCapture('initial video.play() resolved, paused=', video.paused);
      } catch (e) {
        debugCapture('initial video.play() error:', e.message);
      }

      await waitForVideoReady(video);
      videoReady = true;

      empty.style.display = 'none';
      stopBtn.disabled = false;
      captureBtn.disabled = false;
      loopBtn.disabled = false;
      flipBtn.disabled = false;
    } catch (e) {
      flashHint(`camera error: ${e.message}`, 'error');
      videoReady = false;
      startBtn.disabled = false;
      // If a partial stream got opened, clean it up
      if (state.webcamStream) {
        state.webcamStream.getTracks().forEach(t => t.stop());
        state.webcamStream = null;
      }
      video.srcObject = null;
    }
  }

  async function stopCamera() {
    if (state.webcamLoopActive) stopWebcamLoop();
    if (state.webcamStream) {
      state.webcamStream.getTracks().forEach(t => t.stop());
      state.webcamStream = null;
    }
    clearImageCaptureCache();
    video.srcObject = null;
    videoReady = false;
    empty.style.display = '';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    captureBtn.disabled = true;
    loopBtn.disabled = true;
    flipBtn.disabled = true;
    // Clear ANPR overlay
    state.lastDetections.webcam = null;
    const overlay = $('webcamOverlay2');
    if (overlay) {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  // Flip front/back without stopping the loop — just swap the underlying stream
  async function flipCamera() {
    if (!state.webcamStream) return;
    const wasLooping = !!state.webcamLoopActive;
    if (wasLooping) stopWebcamLoop();

    facing.value = facing.value === 'user' ? 'environment' : 'user';
    flipBtn.disabled = true;

    // Stop old tracks first — some mobile browsers can't open two cameras at once
    state.webcamStream.getTracks().forEach(t => t.stop());
    state.webcamStream = null;
    clearImageCaptureCache();
    videoReady = false;

    try {
      const stream = await openCamera(facing.value);
      state.webcamStream = stream;
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* */ }
      await waitForVideoReady(video);
      videoReady = true;
      flipBtn.disabled = false;
      if (wasLooping) startWebcamLoop();
    } catch (e) {
      flashHint(`flip failed: ${e.message}`, 'error');
      // Try to revert
      facing.value = facing.value === 'user' ? 'environment' : 'user';
      try {
        state.webcamStream = await openCamera(facing.value);
        video.srcObject = state.webcamStream;
        await video.play();
        await waitForVideoReady(video);
        videoReady = true;
      } catch (e2) {
        // revert failed too — go back to idle state
        await stopCamera();
      }
      flipBtn.disabled = false;
    }
  }

  startBtn.onclick = startCamera;
  stopBtn.onclick = stopCamera;
  flipBtn.onclick = flipCamera;

  // The dropdown is for desktop convenience; if the user picks from it BEFORE
  // starting, it just sets the initial facing. If AFTER starting, we flip live.
  facing.addEventListener('change', () => {
    if (state.webcamStream) {
      // Need to re-open with the new value — easiest path is flip-style
      const targetFacing = facing.value;
      if (
        (targetFacing === 'user' && !flipBtn.dataset.currentlyBack) ||
        (targetFacing === 'environment' && flipBtn.dataset.currentlyBack)
      ) {
        // already correct, no-op
        return;
      }
      flipCamera();
    }
  });

  captureBtn.onclick = async () => {
    if (!state.webcamStream || !videoReady) {
      flashHint('camera not ready yet', 'info');
      return;
    }
    const blob = await captureFrame(video, state.webcamStream);
    if (!blob || blob.size < 1000) {
      flashHint('frame capture failed — try again in a moment', 'error');
      return;
    }
    recordDiag(blob, blob._apertureMeta || null);
    sendFrame(blob, 'webcam', $('promptWebcam').value);
  };

  loopBtn.onclick = () => {
    if (state.webcamLoopActive) stopWebcamLoop();
    else startWebcamLoop();
  };

  function startWebcamLoop() {
    overlay.hidden = false;
    loopBtn.classList.add('is-active');
    loopBtn.textContent = 'stop auto-loop';

    // Fixed cadence loop. If the backend is still processing the previous
    // frame, we skip that tick rather than queue old frames. The next send is
    // always captured fresh from the live camera.
    state.webcamLoopActive = true;
    let inFlight = false;

    const tick = async () => {
      if (!state.webcamLoopActive) return;
      try {
        if (inFlight) {
          debugCapture('tick skipped: previous request still in flight');
        } else if (state.webcamStream && videoReady) {
          inFlight = true;
          const blob = await captureFrame(video, state.webcamStream);
          debugCapture(`tick: blob=${blob?.size ?? 'null'} bytes`);
          if (blob && blob.size > 1000) {
            recordDiag(blob, blob._apertureMeta || null);
            await sendFrame(blob, 'webcam', $('promptWebcam').value);
          }
          inFlight = false;
        }
      } catch (e) {
        inFlight = false;
        debugCapture('tick error:', e.message);
      }
      if (!state.webcamLoopActive) return;
      const interval = state.mode === "anpr" ? ANPR_SAMPLE_INTERVAL_MS : clampDescribeIntervalSeconds(intervalSlider.value) * 1000;
      state.webcamLoopTimer = setTimeout(tick, interval);
    };
    tick();
  }

  function stopWebcamLoop() {
    state.webcamLoopActive = false;
    if (state.webcamLoopTimer) {
      clearTimeout(state.webcamLoopTimer);
      state.webcamLoopTimer = null;
    }
    state.webcamLoop = null;  // legacy
    overlay.hidden = true;
    loopBtn.classList.remove('is-active');
    loopBtn.textContent = 'start auto-loop';
  }
}

// ============================================================
// CCTV / RTSP TAB
// ============================================================
function initCctvTab() {
  const video = $('cctvVideo');
  const empty = $('cctvEmpty');
  const overlay = $('cctvOverlay');
  const connectBtn = $('rtspConnect');
  const disconnectBtn = $('rtspDisconnect');
  const captureBtn = $('cctvCaptureOnce');
  const loopBtn = $('cctvLoopToggle');
  const intervalSlider = $('cctvInterval');
  const intervalLabel = $('cctvIntervalLabel');
  const intervalDisplay = $('cctvIntervalDisplay');
  const status = $('rtspStatus');

  $('promptCctv').value = 'You are watching a live CCTV camera feed. Describe in detail what is happening — note any people, vehicles, activity, and notable changes from a static scene.';

  function refreshCctvIntervalLabel() {
    const sec = clampDescribeIntervalSeconds(intervalSlider.value);
    intervalSlider.value = String(sec);
    intervalLabel.textContent = formatIntervalSeconds(sec);
    intervalDisplay.textContent = formatIntervalSeconds(sec);
  }
  intervalSlider.addEventListener('input', refreshCctvIntervalLabel);
  refreshCctvIntervalLabel();

  connectBtn.onclick = async () => {
    const rtspUrl = $('rtspUrl').value.trim();
    if (!rtspUrl) { flashHint('enter RTSP URL', 'error'); return; }
    if (!state.apiUrl) { flashHint('configure backend connection first', 'error'); return; }

    connectBtn.disabled = true;
    status.textContent = 'requesting stream…';
    status.style.color = 'var(--text-mute)';

    try {
      const r = await fetch(`${state.apiUrl}/rtsp/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          rtsp_url: rtspUrl,
          username: $('rtspUser').value || null,
          password: $('rtspPass').value || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);

      state.cctvStream = d.stream_id;

      // Wait a moment for FFmpeg to write its first segment, then attach hls.js
      status.textContent = `stream ${d.stream_id} starting · waiting for first segment…`;
      const playlistUrl = `${state.apiUrl}${d.hls_path}`;
      await waitForPlaylist(playlistUrl, 20);
      attachHls(playlistUrl);

      empty.style.display = 'none';
      disconnectBtn.disabled = false;
      captureBtn.disabled = false;
      loopBtn.disabled = false;
      status.textContent = `connected · ${d.stream_id}`;
      status.style.color = 'var(--accent)';
    } catch (e) {
      status.textContent = `failed: ${e.message}`;
      status.style.color = 'var(--error)';
      connectBtn.disabled = false;
      state.cctvStream = null;
    }
  };

  async function waitForPlaylist(url, attempts) {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        if (r.ok) return true;
      } catch (e) { /* keep trying */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('stream did not produce HLS segments in time');
  }

  function attachHls(playlistUrl) {
    if (state.cctvHls) { state.cctvHls.destroy(); state.cctvHls = null; }

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data.fatal) flashHint(`hls error: ${data.details}`, 'error');
      });
      state.cctvHls = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari plays HLS natively
      video.src = playlistUrl;
    } else {
      flashHint('this browser cannot play HLS', 'error');
    }
  }

  disconnectBtn.onclick = async () => {
    if (state.cctvLoopActive) stopCctvLoop();
    if (state.cctvHls) { state.cctvHls.destroy(); state.cctvHls = null; }
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    empty.style.display = '';

    if (state.cctvStream && state.apiUrl) {
      try {
        await fetch(`${state.apiUrl}/rtsp/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ stream_id: state.cctvStream }),
        });
      } catch (e) { /* ignore */ }
    }
    state.cctvStream = null;

    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    captureBtn.disabled = true;
    loopBtn.disabled = true;
    status.textContent = 'disconnected';
    status.style.color = 'var(--text-mute)';
  };

  captureBtn.onclick = async () => {
    if (!state.cctvStream) return;
    const blob = await captureFrame(video, null);
    if (!blob || blob.size < 1000) {
      flashHint('frame capture failed — stream may not be ready', 'error');
      return;
    }
    recordDiag(blob, blob._apertureMeta || null);
    sendFrame(blob, 'cctv', $('promptCctv').value);
  };

  loopBtn.onclick = () => {
    if (state.cctvLoopActive) stopCctvLoop();
    else startCctvLoop();
  };

  function startCctvLoop() {
    overlay.hidden = false;
    loopBtn.classList.add('is-active');
    loopBtn.textContent = 'stop auto-loop';

    state.cctvLoopActive = true;
    let inFlight = false;

    const tick = async () => {
      if (!state.cctvLoopActive) return;
      try {
        if (inFlight) {
          debugCapture('cctv tick skipped: previous request still in flight');
        } else if (state.cctvStream) {
          inFlight = true;
          const blob = await captureFrame(video, null);
          if (blob && blob.size > 1000) {
            recordDiag(blob, blob._apertureMeta || null);
            await sendFrame(blob, 'cctv', $('promptCctv').value);
          }
          inFlight = false;
        }
      } catch (e) {
        inFlight = false;
        debugCapture('cctv tick error:', e.message);
      }
      if (!state.cctvLoopActive) return;
      const interval = state.mode === "anpr" ? ANPR_SAMPLE_INTERVAL_MS : clampDescribeIntervalSeconds(intervalSlider.value) * 1000;
      state.cctvLoopTimer = setTimeout(tick, interval);
    };
    tick();
  }
  function stopCctvLoop() {
    state.cctvLoopActive = false;
    if (state.cctvLoopTimer) {
      clearTimeout(state.cctvLoopTimer);
      state.cctvLoopTimer = null;
    }
    state.cctvLoop = null;
    overlay.hidden = true;
    loopBtn.classList.remove('is-active');
    loopBtn.textContent = 'start auto-loop';
  }
}

// Cleanup on tab close — stop the RTSP stream if any
window.addEventListener('beforeunload', () => {
  if (state.cctvStream && state.apiUrl) {
    // fire-and-forget; modern browsers allow this with sendBeacon for POST
    try {
      navigator.sendBeacon(
        `${state.apiUrl}/rtsp/stop`,
        new Blob([JSON.stringify({ stream_id: state.cctvStream })],
                 { type: 'application/json' }),
      );
    } catch (e) { /* best effort */ }
  }
});

// When the user comes back to the tab, iOS may have paused the video.
// Make sure it's playing again so captures don't return stale frames.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const video = $('webcamVideo');
  if (state.webcamStream && video.paused) {
    debugCapture('visibility returned, restarting video.play()');
    video.play().catch(() => {});
  }
});

// ============================================================
// Visible diagnostics panel (enabled by ?debug=1 in URL)
// ============================================================
// Shows thumbnails of the most recent captures plus per-capture data.
// Critical for debugging on phones without browser dev tools — you can
// SEE whether captures are visually changing or stuck on the same frame.

const _diagState = {
  enabled: false,
  panel: null,
  thumbList: null,
  countLabel: null,
  count: 0,
  maxThumbs: 6,
};

function ensureDiagPanel() {
  injectMobileFixStyles();
  if (_diagState.panel) return;
  const panel = document.createElement('aside');
  panel.id = 'diagPanel';
  panel.innerHTML = `
    <div class="diag-head">
      <span class="diag-title">capture diagnostic</span>
      <span class="diag-count" id="diagCount">0 captures</span>
    </div>
    <div class="diag-thumbs" id="diagThumbs"></div>
    <p class="diag-hint">If thumbnails are all identical, the capture is stuck. If they change but descriptions don't, the bug is downstream.</p>
  `;
  document.body.appendChild(panel);
  _diagState.panel = panel;
  _diagState.thumbList = panel.querySelector('#diagThumbs');
  _diagState.countLabel = panel.querySelector('#diagCount');
}

function recordDiag(blob, currentTimeOrMeta, sizeBytes) {
  const meta = (currentTimeOrMeta && typeof currentTimeOrMeta === 'object')
    ? currentTimeOrMeta
    : (blob?._apertureMeta || {
        id: ++state.captureSeq,
        videoTime: Number(currentTimeOrMeta || 0),
        sizeBytes: sizeBytes || blob?.size || 0,
        capturedAt: Date.now(),
        hash: 'legacy',
      });

  if (!_diagState.enabled) return;
  ensureDiagPanel();
  _diagState.count += 1;
  _diagState.countLabel.textContent = `${_diagState.count} captures`;

  const url = URL.createObjectURL(blob);
  const wrapper = document.createElement('div');
  wrapper.className = 'diag-thumb';
  wrapper.dataset.captureId = String(meta.id || _diagState.count);
  wrapper.innerHTML = `
    <img src="${url}" alt="sent frame ${meta.id || _diagState.count}">
    <div class="diag-thumb-meta">
      <span>#${meta.id || _diagState.count}</span>
      <span>${((meta.sizeBytes || blob?.size || 0) / 1024).toFixed(0)}KB</span>
      <span>v=${Number(meta.videoTime || 0).toFixed(2)}s</span>
      <span>h=${escapeHtml(meta.hash || '—')}</span>
      <span>${escapeHtml(meta.frameMethod || 'draw')}</span>
    </div>
    <div class="diag-thumb-status">sent · waiting for API response…</div>
  `;
  _diagState.thumbList.insertBefore(wrapper, _diagState.thumbList.firstChild);

  while (_diagState.thumbList.children.length > _diagState.maxThumbs) {
    const old = _diagState.thumbList.lastChild;
    const oldImg = old.querySelector('img');
    if (oldImg) URL.revokeObjectURL(oldImg.src);
    old.remove();
  }
}

function updateDiagResult(meta, ok, result) {
  if (!_diagState.enabled || !meta?.id) return;
  const row = document.querySelector(`.diag-thumb[data-capture-id="${String(meta.id)}"]`);
  if (!row) return;
  const status = row.querySelector('.diag-thumb-status');
  if (!status) return;
  if (ok) {
    const inf = result?.inference_seconds != null ? `${Number(result.inference_seconds).toFixed(2)}s` : 'done';
    status.textContent = `API ok · inference ${inf}`;
    status.dataset.state = 'ok';
  } else {
    status.textContent = `API error · ${String(result || 'failed').slice(0, 90)}`;
    status.dataset.state = 'error';
  }
}


// ============================================================
// Mobile UI fixes: larger camera, locked sliders, debug toggle
// ============================================================
function injectMobileFixStyles() {
  if (document.getElementById('apertureMobileFixStyles')) return;
  const style = document.createElement('style');
  style.id = 'apertureMobileFixStyles';
  style.textContent = `
    .commentary-relay-card .feed-list,
    .commentary-relay-card .feed-empty {
      display: none !important;
    }
    .commentary-link-box {
      display: grid;
      gap: 14px;
      color: var(--text-mute);
    }
    .commentary-session-code {
      display: inline-flex;
      padding: 8px 10px;
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 12px;
      background: rgba(255,255,255,.05);
      color: var(--text);
      font-family: "Geist Mono", ui-monospace, monospace;
      letter-spacing: .08em;
    }
    .commentary-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    @media (max-width: 760px) {
      .tabpanel[data-panel="webcam"] .video-frame {
        height: 70vh !important;
        min-height: 470px !important;
        max-height: 760px !important;
      }
      .tabpanel[data-panel="webcam"] #webcamVideo {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
      }
      .commentary-relay-card .feed-list,
      .commentary-relay-card .feed-empty {
        display: none !important;
      }
      .commentary-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .commentary-session-code {
        font-family: "Geist Mono", ui-monospace, monospace;
        letter-spacing: .08em;
        word-break: break-word;
      }
      .tabpanel[data-panel="webcam"] .control-grid,
      .tabpanel[data-panel="cctv"] .control-grid {
        gap: 14px !important;
      }
      input[type="range"].aperture-range-locked {
        pointer-events: none !important;
        opacity: 0.58;
      }
      input[type="range"].aperture-range-unlocked {
        pointer-events: auto !important;
        opacity: 1;
        outline: 2px solid rgba(94, 234, 212, 0.45);
        outline-offset: 8px;
        border-radius: 999px;
      }
      .interval-lock-controls {
        display: grid;
        grid-template-columns: 44px 1fr 44px;
        gap: 8px;
        align-items: center;
        margin-top: 10px;
      }
      .interval-lock-controls button {
        min-height: 40px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.06);
        color: inherit;
        font: inherit;
      }
      .interval-lock-controls .unlock-range[data-unlocked="true"] {
        border-color: rgba(94, 234, 212, .65);
        color: #5eead4;
      }
      #diagPanel {
        position: fixed;
        left: 10px;
        right: 10px;
        bottom: 10px;
        z-index: 9999;
        max-height: 38vh;
        overflow: auto;
        padding: 10px;
        border-radius: 18px;
        background: rgba(8, 9, 12, 0.93);
        backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,.14);
        box-shadow: 0 18px 60px rgba(0,0,0,.45);
      }
      .diag-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
        font-weight: 700;
      }
      .diag-thumbs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .diag-thumb {
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.04);
      }
      .diag-thumb img {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        background: #111;
      }
      .diag-thumb-meta,
      .diag-thumb-status,
      .diag-hint {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 6px;
        font-size: 10px;
        line-height: 1.25;
        color: rgba(255,255,255,.74);
      }
      .diag-thumb-status[data-state="ok"] { color: #5eead4; }
      .diag-thumb-status[data-state="error"] { color: #fb7185; }
      .diag-hint { margin: 8px 0 0; }
    }
  `;
  document.head.appendChild(style);
}

function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function initIntervalSliderGuard(sliderId) {
  const slider = $(sliderId);
  if (!slider || slider.dataset.guardReady === '1' || !isTouchDevice()) return;
  slider.dataset.guardReady = '1';

  const controls = document.createElement('div');
  controls.className = 'interval-lock-controls';
  controls.innerHTML = `
    <button type="button" class="range-minus" aria-label="decrease interval">−</button>
    <button type="button" class="unlock-range" aria-label="unlock interval slider">unlock slider</button>
    <button type="button" class="range-plus" aria-label="increase interval">+</button>
  `;
  slider.insertAdjacentElement('afterend', controls);

  let relockTimer = null;
  const unlockBtn = controls.querySelector('.unlock-range');
  const min = Number(slider.min || 1);
  const max = Number(slider.max || 30);
  const step = Number(slider.step || 1);

  function emitInput() {
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setLocked(locked) {
    slider.classList.toggle('aperture-range-locked', locked);
    slider.classList.toggle('aperture-range-unlocked', !locked);
    unlockBtn.dataset.unlocked = String(!locked);
    unlockBtn.textContent = locked ? 'unlock slider' : 'slider unlocked';
    if (relockTimer) clearTimeout(relockTimer);
    if (!locked) {
      relockTimer = setTimeout(() => setLocked(true), 7000);
    }
  }
  function nudge(delta) {
    const current = Number(slider.value || min);
    slider.value = String(Math.max(min, Math.min(max, current + delta)));
    emitInput();
  }

  controls.querySelector('.range-minus').addEventListener('click', () => nudge(-step));
  controls.querySelector('.range-plus').addEventListener('click', () => nudge(step));
  unlockBtn.addEventListener('click', () => setLocked(false));
  slider.addEventListener('pointerup', () => setTimeout(() => setLocked(true), 250));
  slider.addEventListener('change', () => setTimeout(() => setLocked(true), 250));
  setLocked(true);
}

function addDebugToggleButton() {
  if ($('toggleDebugFrames')) return;
  const loopBtn = $('webcamLoopToggle');
  if (!loopBtn) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'toggleDebugFrames';
  btn.className = 'btn btn-ghost';
  btn.textContent = _diagState.enabled ? 'hide sent frames' : 'debug sent frames';
  btn.addEventListener('click', () => {
    _diagState.enabled = !_diagState.enabled;
    btn.textContent = _diagState.enabled ? 'hide sent frames' : 'debug sent frames';
    if (_diagState.enabled) {
      ensureDiagPanel();
      flashHint('debug panel on: it shows the exact JPEGs sent to backend', 'ok');
    } else if (_diagState.panel) {
      _diagState.panel.remove();
      _diagState.panel = null;
      _diagState.thumbList = null;
      _diagState.countLabel = null;
    }
  });
  loopBtn.insertAdjacentElement('afterend', btn);
}

// ============================================================
// INIT
// ============================================================

// URL-based debug toggle: visit ?debug=1 to see capture-pipeline diagnostics
// in the console AND the on-page diagnostics panel.
if (new URLSearchParams(location.search).has('debug')) {
  window.APERTURE_DEBUG_CAPTURE = true;
  window.APERTURE_DEBUG_ANPR = true;
  _diagState.enabled = true;
  console.log('[aperture] debug logging ON (capture + anpr)');
}

// Best-effort detection: touch device + narrow viewport → mobile.
// Used to pick a sensible default camera. The user can still flip.
function isLikelyMobile() {
  return ('ontouchstart' in window) && window.innerWidth <= 900;
}

document.addEventListener('DOMContentLoaded', () => {
  // Restore last-used mode
  try {
    const stored = localStorage.getItem(LS_MODE);
    if (stored && MODES.includes(stored)) state.mode = stored;
  } catch (e) { /* ignore */ }
  document.body.dataset.mode = state.mode;

  initModeSwitch();
  loadCreds();
  initTabs();
  initImageTab();
  initWebcamTab();
  initCctvTab();
  renderFeed();
  renderPlates();
  startOverlayLoop();
  injectMobileFixStyles();
  initCommentarySenderUi();
  initIntervalSliderGuard('webcamInterval');
  initIntervalSliderGuard('cctvInterval');
  addDebugToggleButton();

  // Default to back-facing camera on mobile (it's what users mean by "the camera")
  if (isLikelyMobile()) {
    $('webcamFacing').value = 'environment';
  }

  $('testConn').addEventListener('click', testConnection);
  $('saveCreds').addEventListener('click', saveCreds);
  $('clearPlates').addEventListener('click', clearPlates);

  // If we have stored creds, auto-test
  if ($('apiUrl').value && $('apiKey').value) {
    setTimeout(testConnection, 200);
  }
});

function initModeSwitch() {
  const buttons = $$('.mode-btn');
  const rail = $('modeRail');

  function moveRail() {
    const active = buttons.find((b) => b.classList.contains('is-active'));
    if (!active) return;
    rail.style.left = `${active.offsetLeft}px`;
    rail.style.width = `${active.offsetWidth}px`;
  }

  function activate(mode) {
    if (!MODES.includes(mode)) return;
    state.mode = mode;
    document.body.dataset.mode = mode;
    try { localStorage.setItem(LS_MODE, mode); } catch (e) { /* */ }

    buttons.forEach((b) => {
      const isActive = b.dataset.mode === mode;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', isActive);
    });
    moveRail();

    // Reload credentials for the new mode
    loadCreds();

    // Clear connection status — the URL has likely changed
    setConnState('idle', 'awaiting connection');
    $('connDetail').textContent = '';
    stopStatsPolling();

    // Auto-test if there are creds for this mode
    if ($('apiUrl').value && $('apiKey').value) {
      setTimeout(testConnection, 200);
    }

    // Force a redraw of overlays for the new mode
    redrawAllOverlays();
  }

  buttons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.mode)));
  // Initial rail positioning
  requestAnimationFrame(() => requestAnimationFrame(moveRail));
  window.addEventListener('resize', moveRail);

  // Sync button state with restored mode
  buttons.forEach((b) => {
    const isActive = b.dataset.mode === state.mode;
    b.classList.toggle('is-active', isActive);
    b.setAttribute('aria-selected', isActive);
  });
}

})();
