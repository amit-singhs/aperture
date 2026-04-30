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
const LS_KEY = 'aperture.creds.v1';

// ---------- state ----------
const state = {
  apiUrl: '',
  apiKey: '',
  feed: [],            // newest first, capped at MAX_FEED
  webcamStream: null,
  webcamLoop: null,
  cctvStream: null,    // backend stream id
  cctvHls: null,       // hls.js instance
  cctvLoop: null,
  selectedFile: null,
  statsTimer: null,
};

// ---------- creds ----------
function loadCreds() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (!v) return;
    const { url, key } = JSON.parse(v);
    if (url) $('apiUrl').value = url;
    if (key) $('apiKey').value = key;
  } catch (e) { /* ignore */ }
}
function saveCreds() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      url: $('apiUrl').value.trim(),
      key: $('apiKey').value.trim(),
    }));
    flashHint('saved to this browser');
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
  return state.apiKey ? { 'X-API-Key': state.apiKey } : {};
}

function flashHint(msg, kind = 'info') {
  const el = $('connDetail');
  el.textContent = msg;
  el.style.color = kind === 'error' ? 'var(--error)'
                : kind === 'ok'    ? 'var(--accent)'
                                   : 'var(--text-mute)';
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
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
  try {
    const r = await fetch(`${url}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    let label = 'connected';
    if (d.gpu) label = `${d.gpu.name.toLowerCase()}`;
    setConnState('ok', label);

    // Then check /ready
    const r2 = await fetch(`${url}/ready`);
    if (r2.ok) {
      const d2 = await r2.json();
      flashHint(`ready · model ${d2.model_vram_gb.toFixed(1)} GB · ${d.gpu.vram_total_gb.toFixed(0)} GB total`, 'ok');
      $('docsLink').href = `${url}/docs`;
      $('statBackend').textContent = (d.gpu?.name || 'connected').toLowerCase();
      startStatsPolling();
    } else {
      flashHint('connected, but model still loading…', 'info');
    }
  } catch (e) {
    setConnState('error', 'unreachable');
    flashHint(`error: ${e.message}`, 'error');
    stopStatsPolling();
  }
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
    if (!r.ok) return;
    const d = await r.json();
    $('statUptime').textContent = formatUptime(d.uptime_seconds);
    $('statRequests').textContent = `${d.requests_succeeded}/${d.requests_failed}`;
    $('statLatency').textContent = d.average_inference_seconds
      ? `${d.average_inference_seconds.toFixed(2)}s` : '—';
    $('statQueue').textContent = d.queue_depth ?? '—';
    if (d.vram_allocated_gb != null) {
      $('statVram').textContent = `${d.vram_allocated_gb.toFixed(1)} GB`;
    }
  } catch (e) { /* ignore */ }
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
  // entry: { description, source, inference_seconds, queue_wait_seconds, error }
  state.feed.unshift({ ...entry, ts: new Date() });
  if (state.feed.length > MAX_FEED) {
    // explicit free of old entries — keeps memory flat for long sessions
    state.feed.length = MAX_FEED;
  }
  renderFeed();
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
    return `
      <article class="feed-item ${cls}${newestCls}">
        <header class="feed-item-head">
          <span class="feed-item-time">${time}</span>
          <span class="feed-item-source">${e.error ? 'error' : src}</span>
        </header>
        <div class="feed-item-body">${body}</div>
        ${e.error ? '' : `
        <footer class="feed-item-foot">
          <span><span class="stat-key">inference</span> <span class="stat-val">${inf}</span></span>
          ${wait ? `<span><span class="stat-key">${wait}</span></span>` : ''}
        </footer>`}
      </article>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

$('clearFeed').onclick = () => { state.feed = []; renderFeed(); };

// ---------- core: send a frame ----------
async function sendFrame(blob, sourceLabel, prompt) {
  if (!state.apiUrl) {
    flashHint('configure backend connection first', 'error');
    return;
  }
  const fd = new FormData();
  fd.append('image', blob, 'frame.jpg');
  fd.append('prompt', prompt || DEFAULT_PROMPT);
  fd.append('source_type', sourceLabel || 'frame');
  fd.append('source_id', 'aperture-frontend');

  try {
    const r = await fetch(`${state.apiUrl}/describe`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      pushFeed({
        description: d.detail || `HTTP ${r.status}`,
        source: sourceLabel,
        error: true,
      });
      return;
    }
    pushFeed({
      description: d.description,
      source: sourceLabel,
      inference_seconds: d.inference_seconds,
      queue_wait_seconds: d.queue_wait_seconds,
    });
  } catch (e) {
    pushFeed({ description: `network error · ${e.message}`, source: sourceLabel, error: true });
  }
}

function videoToBlob(videoEl) {
  return new Promise((resolve) => {
    const canvas = $('frameCanvas');
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
  });
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
  };
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

  $('promptWebcam').value = DEFAULT_PROMPT;

  intervalSlider.addEventListener('input', () => {
    intervalLabel.textContent = `${intervalSlider.value}s`;
    intervalDisplay.textContent = intervalSlider.value;
  });

  startBtn.onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 }, height: { ideal: 720 },
          facingMode: facing.value,
        },
        audio: false,
      });
      state.webcamStream = stream;
      video.srcObject = stream;
      empty.style.display = 'none';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      captureBtn.disabled = false;
      loopBtn.disabled = false;
    } catch (e) {
      flashHint(`camera error: ${e.message}`, 'error');
    }
  };

  stopBtn.onclick = () => {
    if (state.webcamLoop) stopWebcamLoop();
    if (state.webcamStream) {
      state.webcamStream.getTracks().forEach(t => t.stop());
      state.webcamStream = null;
    }
    video.srcObject = null;
    empty.style.display = '';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    captureBtn.disabled = true;
    loopBtn.disabled = true;
  };

  captureBtn.onclick = async () => {
    if (!state.webcamStream) return;
    const blob = await videoToBlob(video);
    sendFrame(blob, 'webcam', $('promptWebcam').value);
  };

  loopBtn.onclick = () => {
    if (state.webcamLoop) stopWebcamLoop();
    else startWebcamLoop();
  };

  function startWebcamLoop() {
    const interval = Math.max(1, parseInt(intervalSlider.value, 10)) * 1000;
    overlay.hidden = false;
    loopBtn.classList.add('is-active');
    loopBtn.textContent = 'stop auto-loop';
    const tick = async () => {
      if (!state.webcamStream) return;
      const blob = await videoToBlob(video);
      sendFrame(blob, 'webcam', $('promptWebcam').value);
    };
    tick();
    state.webcamLoop = setInterval(tick, interval);
  }

  function stopWebcamLoop() {
    clearInterval(state.webcamLoop);
    state.webcamLoop = null;
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

  intervalSlider.addEventListener('input', () => {
    intervalLabel.textContent = `${intervalSlider.value}s`;
    intervalDisplay.textContent = intervalSlider.value;
  });

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
    if (state.cctvLoop) stopCctvLoop();
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
    const blob = await videoToBlob(video);
    sendFrame(blob, 'cctv', $('promptCctv').value);
  };

  loopBtn.onclick = () => {
    if (state.cctvLoop) stopCctvLoop();
    else startCctvLoop();
  };

  function startCctvLoop() {
    const interval = Math.max(1, parseInt(intervalSlider.value, 10)) * 1000;
    overlay.hidden = false;
    loopBtn.classList.add('is-active');
    loopBtn.textContent = 'stop auto-loop';
    const tick = async () => {
      if (!state.cctvStream) return;
      const blob = await videoToBlob(video);
      sendFrame(blob, 'cctv', $('promptCctv').value);
    };
    tick();
    state.cctvLoop = setInterval(tick, interval);
  }
  function stopCctvLoop() {
    clearInterval(state.cctvLoop);
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

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadCreds();
  initTabs();
  initImageTab();
  initWebcamTab();
  initCctvTab();
  renderFeed();

  $('testConn').addEventListener('click', testConnection);
  $('saveCreds').addEventListener('click', saveCreds);

  // If we have stored creds, auto-test
  if ($('apiUrl').value && $('apiKey').value) {
    setTimeout(testConnection, 200);
  }
});

})();
