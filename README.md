# Remote Browser Rendering

Streams a real Chromium tab to any browser over WebSocket: JPEG frames via CDP
screencast for video, Opus/WebM for audio, and click/scroll/type/navigate
interactions relayed back to the page.

## Features

- **Binary frame protocol** — a small fixed header (format, frame number,
  timestamp, width, height) followed by the raw JPEG payload; no Base64, no
  per-message JSON overhead.
- **Adaptive quality** — capture resolution is scaled to a fixed pixel budget
  and JPEG quality is tuned every 2s from measured Chrome encode latency, so a
  small server (e.g. Render's free 0.5 vCPU / 512MB plan) stays at target FPS
  instead of falling behind.
- **Real audio** — Chrome renders into a virtual PulseAudio sink; ffmpeg reads
  its monitor source, encodes to Opus/WebM, and the client plays it back via
  MediaSource. This is whole-browser audio (all tabs mixed), not per-tab.
- **Multi-tab** — up to 3 tabs per session, switching restarts the screencast
  for the newly active tab.
- **Mobile emulation** — UA, viewport, and touch input toggle together based
  on the client's own viewport/UA.
- **Auto-reconnect** — exponential backoff WebSocket reconnect with jitter.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000`. Audio capture requires `ffmpeg` and a running
PulseAudio daemon with a `virtual_speaker` null sink — see
[Docker](#docker) below, or run `docker-entrypoint.sh` locally on Linux.

## Architecture

```
public/
  index.html       UI shell, settings menu, canvas + hidden <audio>
  browser.js       RemoteBrowserClient: WebSocket, frame decode/render,
                   MediaSource audio playback, input capture
src/
  server.js        Express static host, WebSocket message routing,
                   Chromium launch flags, stale-session sweep
  browserPool.js   Puppeteer browser lifecycle (acquire/release/cleanup)
  streamManager.js Per-session state: CDP screencast, ffmpeg audio capture,
                   adaptive quality, tab management, input dispatch
docker-entrypoint.sh  Starts PulseAudio + virtual sink before the server
```

Each WebSocket connection may hold at most one active session
(`StreamManager.sessions`). A session owns a Puppeteer `Browser`, one or more
tabs (each with its own `Page` + CDP session), and optionally one ffmpeg
process for audio.

### Video pipeline

1. `Page.startScreencast` (CDP) delivers JPEG frames from the active tab.
2. The server acks each frame — delayed when the client is behind schedule or
   the socket is backed up, which throttles Chrome's encoder at the source
   instead of dropping frames after paying to encode them.
3. Every frame is framed as `[u8 format=2][u32 frameNumber][f64 timestamp][u16 width][u16 height][JPEG bytes]`
   and sent as a single binary WebSocket message (no compression — JPEG is
   already compressed).
4. The client decodes via `ImageDecoder` (WebCodecs) with an `ImageBitmap`
   fallback, and draws 1:1 into a canvas sized to the decoded frame; CSS scales
   the canvas up, so the GPU compositor does the upscaling instead of the CPU.

A background timer re-measures Chrome's ack→delivery latency and nudges JPEG
quality up or down every 2 seconds, within `[MIN_QUALITY, MAX_QUALITY]`.

### Audio pipeline

1. Chrome's audio output goes to a null-sink named `virtual_speaker` (created
   by `docker-entrypoint.sh`); nothing plays out audibly, it just exists as a
   capturable PCM stream.
2. `ffmpeg -f pulse -i virtual_speaker.monitor ... -c:a libopus -f webm ...`
   emits small WebM/Opus clusters on `stdout`.
3. Each cluster is framed as `[u8 format=3][f64 timestamp][WebM bytes]` and
   sent as a binary WebSocket message. The client keeps a `MediaSource` +
   `SourceBuffer` and appends clusters in order, gated on `updateend`, with a
   bounded queue so a stalled buffer can't accumulate memory.
4. Audio starts/stops independently of video via a dedicated `{ type: 'audio',
   enabled }` message, so it can be toggled mid-session without restarting the
   screencast.

### Input path

Clicks and scrolls go straight to CDP (`Input.dispatchMouseEvent`) without
`await`ing each call — CDP preserves send order per session, so blocking on
the round trip only adds latency. Scroll deltas from rapid wheel/touch events
are coalesced server-side and flushed once per tick as a single wheel event.

## WebSocket protocol

### Client → Server (JSON)
```jsonc
{ "type": "start", "url": "https://example.com", "quality": 60, "width": 1280, "height": 720, "isMobile": false, "enableAudio": false }
{ "type": "stop", "sessionId": "…" }
{ "type": "update", "sessionId": "…", "quality": 70 }
{ "type": "audio", "sessionId": "…", "enabled": true }
{ "type": "tab", "sessionId": "…", "action": "create" | "switch" | "close", "url": "…", "tabId": "…" }
{ "type": "interact", "sessionId": "…", "action": { "type": "click" | "scroll" | "type" | "key" | "navigate", "...": "…" } }
```

### Server → Client (JSON)
```jsonc
{ "type": "started", "sessionId": "…" }
{ "type": "progress", "progress": 50, "message": "…", "subtext": "…" }
{ "type": "pageInfo", "sessionId": "…", "tabId": "…", "url": "…", "title": "…" }
{ "type": "tabState", "activeTabId": "…", "tabs": [{ "id": "…", "title": "…", "url": "…" }] }
{ "type": "audioInit", "mimeType": "audio/webm; codecs=\"opus\"" }
{ "type": "stopped" }
{ "type": "error", "message": "…" }
```

### Server → Client (binary)
Video: `[u8 format=2][u32 BE frameNumber][f64 BE timestamp][u16 BE width][u16 BE height][JPEG bytes]`
Audio: `[u8 format=3][f64 BE timestamp][WebM/Opus bytes]`

## Deployment

### Docker (Recommended)
```bash
docker build -t remote-browser .
docker run -p 3000:3000 remote-browser
```
The image installs `chromium`, `pulseaudio`, and `ffmpeg`, and
[docker-entrypoint.sh](docker-entrypoint.sh) starts PulseAudio and the `virtual_speaker` null sink
before `npm start` runs.

### Oracle Cloud (Always Free ARM)
See [OCI_DEPLOY.md](OCI_DEPLOY.md) for full guide deploying to Ampere A1 shape using [docker-compose.oracle.yml](docker-compose.oracle.yml).

### Render.com (free plan constraints)
`MAX_BROWSERS` must stay at `1` — a second Chromium instance will OOM a 512MB
container. Capture resolution and JPEG quality already adapt to a ~0.5 vCPU
budget (see `PIXEL_BUDGET` / quality tuner in `streamManager.js`); raising
those constants on a bigger instance is the main lever for higher fidelity.
The free instance also sleeps after ~15 minutes idle, so the first connection
after that pays a cold start including a fresh Chromium + PulseAudio launch.

### Environment variables
```bash
PORT=3000                       # HTTP/WS port
MAX_BROWSERS=1                  # Concurrent Puppeteer browsers
DEBUG_STREAM=1                  # Verbose screencast/audio/command logging
BLOCK_MEDIA=1                   # Opt-in: block video/audio files to save bandwidth (breaks players)
FFMPEG_PATH=ffmpeg              # Override if ffmpeg isn't on PATH
PULSE_AUDIO_SOURCE=virtual_speaker.monitor
AUDIO_BITRATE=32k
```

## Browser support

Video requires WebCodecs (`ImageDecoder`) for the fast path, with an
`ImageBitmap`/`<img>` fallback for older browsers. Audio requires
`MediaSource` with WebM/Opus support — current Chrome, Edge, and Firefox;
Safari's MSE/Opus support is inconsistent, so audio may not play there even
though video does.

## Troubleshooting

- **No audio despite enabling it**: confirm `ffmpeg` and `pulseaudio` are
  installed and reachable (`FFMPEG_PATH`), and that `virtual_speaker` exists
  (`pactl list sinks short`). Outside Docker, `docker-entrypoint.sh` isn't run
  automatically — start PulseAudio and the sink yourself.
- **High memory / OOM on a small instance**: keep `MAX_BROWSERS=1`, avoid
  raising `PIXEL_BUDGET`, and confirm nothing else is competing for the
  container's RAM.
- **Frames stutter or quality keeps dropping**: check `DEBUG_STREAM=1` logs
  for the `screencast stats` line — a high `encode=` value means Chrome itself
  is CPU-bound, not the network.

## License

MIT

## Contributing

Pull requests are welcome. For major changes, please open an issue first.
