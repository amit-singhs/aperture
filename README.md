# Aperture — Frame Intelligence

Frontend for two backend APIs:
- **Commentary mode**: video scene description via Qwen2.5-VL
- **ANPR mode**: license-plate detection + OCR via YOLOv11 + EasyOCR

A mode switcher in the topbar toggles between the two. Each mode keeps its own URL + key in the browser, so you can have both Colab notebooks running and switch between them at will.
- **Webcam** — use your device camera, with auto-loop sampling
- **CCTV** — connect to an RTSP stream via the backend's RTSP→HLS proxy

Works on desktop and mobile browsers. Logs cap at 10 entries (older descriptions are dropped from memory).

## Files

- `index.html` · `style.css` · `script.js` — the entire frontend, no build step
- `vercel.json` — minimal security headers for the static deploy

## Run locally

Just open `index.html` in your browser. That's it. No npm, no bundler, no build.

If your browser blocks `fetch` from `file://` (some do), serve the directory:

```bash
python -m http.server 8080
# then open http://localhost:8080
```

## Deploy to Vercel

### Option A — drag and drop

1. Sign in at https://vercel.com (free tier is fine)
2. Click **Add New → Project → Import Git Repository** OR scroll down to **Deploy a Template** and use the manual upload
3. Drag this folder onto the page (or push to GitHub and import)
4. No build command, no install command — Vercel auto-detects this is a static site
5. Click Deploy. You'll get a URL like `aperture-xxxx.vercel.app`

### Option B — CLI

```bash
npm i -g vercel
cd /path/to/this/folder
vercel        # answer the prompts; accept defaults for a static site
```

### Option C — GitHub auto-deploy

Push these files to a GitHub repo, connect it in the Vercel dashboard. Every push redeploys.

## Configure the backend URL

After deployment, open the site, expand **backend connection**, and paste:

- **API base URL** — your ngrok URL from the Colab notebook (e.g. `https://pushcart-errand-character.ngrok-free.dev`). No trailing slash.
- **API key** — value of the `API_KEY` secret you set in Colab.

Click **test connection** — green "ok" pill = ready. Click **remember** to save them in this browser's localStorage.

The ngrok URL changes every time you restart Colab, so you'll need to update the URL each session.

## Production notes

This frontend is **stateless** — it has no backend of its own. All it does is POST frames to whatever URL you configure. That means:

- No environment variables to set on Vercel
- No serverless functions, no API routes
- Free tier handles unlimited deployments and reasonable bandwidth

If you want to lock the URL down (e.g. only your team can use it), use Vercel's password protection on the deployment (Project Settings → Deployment Protection).

## Mobile usage

Open the deployed URL in mobile Safari/Chrome. The webcam tab uses `getUserMedia` — works fine on iOS and Android. The "front" / "back" camera selector picks the appropriate camera (`facingMode: 'user'` or `'environment'`).

For RTSP streams, your camera must be reachable from the Colab kernel (i.e. on a public IP), not just from your phone.

## Architecture

```
   ┌─────────────┐                        ┌──────────────────┐
   │  this app   │ ◄── HTTPS frames ─────►│  Colab notebook  │
   │  (static    │      via ngrok URL    │  · Qwen2.5-VL    │
   │   on Vercel)│                        │  · FastAPI       │
   └─────────────┘                        │  · RTSP proxy    │
        │                                 └──────┬───────────┘
        │ webcam / file                          │
        │   (browser local)                      │ ffmpeg
        │                                        ▼
        │              ┌──────────────────┐
        └─────────────►│   RTSP camera    │
                       │  (public IP)     │
                       └──────────────────┘
```

The backend never sees a YouTube URL or a camera URL the browser opened — it only sees whatever frames you POST. RTSP is the one exception, where the *backend* opens the stream and proxies HLS back to the browser.
