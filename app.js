const $ = (id) => document.getElementById(id);

const video = $("video");
const overlay = $("overlay");
const capture = $("capture");
const statusEl = $("status");
const platesEl = $("plates");

let stream = null;
let timer = null;
let inFlight = false;
let lastDetections = [];
let lastResponse = null;
let frameSeq = 0;

function setStatus(text, cls = "") {
  statusEl.className = "status " + cls;
  statusEl.textContent = text;
}

function normalizeBackendUrl() {
  return $("backendUrl").value.trim().replace(/\/$/, "");
}

async function loadCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");
    const select = $("cameraSelect");
    select.innerHTML = "";
    cams.forEach((cam, idx) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${idx + 1}`;
      select.appendChild(opt);
    });
    if (!cams.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No camera found";
      select.appendChild(opt);
    }
  } catch (err) {
    setStatus("Camera list failed: " + err.message, "bad");
  }
}

async function stopAll() {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = false;
  lastDetections = [];
  drawOverlay();

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.srcObject = null;
  setStatus("Stopped.");
}

async function startCamera() {
  await stopAll();
  const deviceId = $("cameraSelect").value;
  const constraints = {
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      deviceId: deviceId ? { exact: deviceId } : undefined
    }
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  video.controls = false;
  await video.play();
  await loadCameras();
  startSendingFrames();
  setStatus("Camera started. Sending frames...", "ok");
}

async function startDirectVideoUrl() {
  await stopAll();
  const url = $("videoUrl").value.trim();
  if (!url) return setStatus("Enter a direct video URL first.", "bad");

  if (/youtube\.com|youtu\.be/i.test(url)) {
    return setStatus("YouTube player pixels cannot be captured directly in browser JS. Use a direct video stream or server-side YouTube extraction.", "bad");
  }
  if (/^rtsp:\/\//i.test(url)) {
    return setStatus("RTSP cannot be opened directly by browser JS. Convert RTSP to WebRTC/HLS, or process RTSP server-side.", "bad");
  }

  video.crossOrigin = "anonymous";
  video.src = url;
  video.controls = true;
  await video.play();
  startSendingFrames();
  setStatus("Direct video started. Sending frames...", "ok");
}

function startSendingFrames() {
  if (timer) clearInterval(timer);
  const fps = Math.max(0.2, Number($("fps").value || 1));
  const interval = Math.round(1000 / fps);
  timer = setInterval(captureAndSendFrame, interval);
  captureAndSendFrame();
}

function captureAndSendFrame() {
  const backendUrl = normalizeBackendUrl();
  if (!backendUrl) return setStatus("Paste your Colab ngrok backend URL first.", "bad");
  if (!video.videoWidth || !video.videoHeight) return;
  if (inFlight) return; // skip frame if backend is still busy, keeps latency low

  try {
    const maxW = Math.max(320, Number($("maxFrameWidth")?.value || 960));
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const scale = Math.min(1, maxW / srcW);
    capture.width = Math.round(srcW * scale);
    capture.height = Math.round(srcH * scale);
    const ctx = capture.getContext("2d", { willReadFrequently: false });
    ctx.drawImage(video, 0, 0, capture.width, capture.height);
  } catch (err) {
    setStatus("Could not capture this video frame. Most likely CORS/canvas restriction: " + err.message, "bad");
    return;
  }

  const quality = Math.min(1, Math.max(0.3, Number($("jpegQuality").value || 0.75)));
  capture.toBlob(async (blob) => {
    if (!blob || inFlight) return;
    inFlight = true;
    const t0 = performance.now();

    frameSeq += 1;
    const ocrEvery = Math.max(1, Number($("ocrEvery")?.value || 3));
    const shouldOcr = frameSeq % ocrEvery === 1;

    const form = new FormData();
    form.append("image", blob, "frame.jpg");
    form.append("source_id", $("sourceId").value || "default");
    form.append("conf", $("conf").value || "0.25");
    form.append("iou", $("iou").value || "0.45");
    form.append("ocr_enabled", shouldOcr ? "true" : "false");
    form.append("region_hint", $("regionHint")?.value || "AUTO");

    try {
      const res = await fetch(`${backendUrl}/detect_frame`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      const roundTrip = Math.round(performance.now() - t0);

      if (!data.ok) throw new Error(data.error || "Backend error");
      lastResponse = data;
      lastDetections = data.detections || [];
      drawOverlay();
      renderPlates(data, roundTrip);
      const ocrUsed = lastDetections.filter(d => d.ocr_used_this_frame).length;
      setStatus(`OK | backend ${data.processing_ms} ms | round trip ${roundTrip} ms | detections ${lastDetections.length} | OCR used ${ocrUsed}`, "ok");
    } catch (err) {
      setStatus("Request failed: " + err.message, "bad");
    } finally {
      inFlight = false;
    }
  }, "image/jpeg", quality);
}

function resizeOverlayToVideoBox() {
  const rect = video.getBoundingClientRect();
  const parentRect = video.parentElement.getBoundingClientRect();
  overlay.width = Math.max(1, Math.round(parentRect.width));
  overlay.height = Math.max(1, Math.round(parentRect.height));
}

function drawOverlay() {
  resizeOverlayToVideoBox();
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lastResponse || !lastResponse.image_width || !lastResponse.image_height) return;

  // Because video uses object-fit: contain, account for letterboxing.
  const imgW = lastResponse.image_width;
  const imgH = lastResponse.image_height;
  const boxW = overlay.width;
  const boxH = overlay.height;
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const offsetX = (boxW - drawW) / 2;
  const offsetY = (boxH - drawH) / 2;

  ctx.lineWidth = 3;
  ctx.font = "bold 16px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "bottom";

  for (const det of lastDetections) {
    const b = det.box;
    const x = offsetX + b.x1 * scale;
    const y = offsetY + b.y1 * scale;
    const w = (b.x2 - b.x1) * scale;
    const h = (b.y2 - b.y1) * scale;
    const label = `${det.plate_text || "PLATE"} ${Math.round((det.detection_confidence || 0) * 100)}%`;

    ctx.strokeStyle = det.is_unique_within_2h ? "#3fb950" : "#f2cc60";
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.strokeRect(x, y, w, h);

    const textW = ctx.measureText(label).width + 12;
    const textH = 22;
    const labelY = Math.max(0, y - textH - 2);
    ctx.fillRect(x, labelY, textW, textH);
    ctx.fillStyle = det.is_unique_within_2h ? "#7ee787" : "#f8e3a1";
    ctx.fillText(label, x + 6, labelY + textH - 4);
  }
}

function renderPlates(data, roundTrip) {
  const detections = data.detections || [];
  platesEl.innerHTML = "";
  if (!detections.length) {
    platesEl.innerHTML = `<div class="small">No plates detected in latest frame.</div>`;
    return;
  }

  for (const det of detections) {
    const div = document.createElement("div");
    div.className = "plate";
    const fmt = det.format_pattern ? ` | format: ${det.format_pattern}` : "";
    const raw = det.raw_ocr_text ? `<div class="small">raw OCR: ${det.raw_ocr_text}</div>` : "";
    div.innerHTML = `
      <div><strong>${det.plate_text || "Unread"}</strong> ${det.is_unique_within_2h ? "<span class='ok'>NEW</span>" : "<span>seen</span>"}</div>
      <div class="small">track: ${det.track_id} | det: ${det.detection_confidence} | OCR: ${det.ocr_confidence}${fmt} | ${data.processing_ms} ms backend | ${roundTrip} ms total</div>
      <div class="small">box: x=${det.box.x1}, y=${det.box.y1}, w=${det.box.w}, h=${det.box.h}</div>
      ${raw}
    `;
    platesEl.appendChild(div);
  }
}

$("startCamera").addEventListener("click", () => startCamera().catch(err => setStatus(err.message, "bad")));
$("startVideoUrl").addEventListener("click", () => startDirectVideoUrl().catch(err => setStatus(err.message, "bad")));
$("stop").addEventListener("click", stopAll);
$("fps").addEventListener("change", () => { if (timer) startSendingFrames(); });
window.addEventListener("resize", drawOverlay);

loadCameras();
setStatus("Ready. Paste backend URL, then start camera or direct video.");
