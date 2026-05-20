# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A browser-based video conferencing app. WebRTC peer-to-peer in a **mesh topology** for media (no SFU), with a tiny Node.js + Socket.io server used only for **signaling, room membership, and chat fan-out**. Capable of ~6–8 participants per room; beyond that, an SFU (mediasoup, Janus, LiveKit) would be required.

## Commands

```bash
npm install          # install express + socket.io
npm start            # runs `node server.js` on PORT (default 3000)
PORT=4000 npm start  # override port
curl http://localhost:3000/health   # liveness probe → {"ok":true}
```

There is no test suite, linter, or build step — the frontend is a single static `public/index.html` served as-is. The server is plain CommonJS; no transpile.

Node **18+** is required (declared in `package.json` `engines`).

## Architecture

Three files do everything; understand how they cooperate before changing any one of them.

### `server.js` — signaling + post-meeting AI summarize

The server has **two responsibilities, both stateless**:

1. **Signaling** (the original job — never sees realtime media):
   - Express serves `public/`. Socket.io is mounted on the same HTTP server (clients load `/socket.io/socket.io.js` automatically).
   - In-memory `rooms: Map<roomId, Map<socketId, {name}>>`. No persistence — restarting the server drops all rooms. The room entry is deleted when the last peer leaves.
   - Socket events form the wire protocol with the browser; **the names below are load-bearing** — clients hard-code them:
     - `join {roomId, name}` → ack `{ok, selfId, peers}`; server emits `peer-joined` to others and `peers` (full roster) to room.
     - `signal {to, data}` → relayed verbatim to `to` as `signal {from, data}`. `data` is opaque to the server (carries SDP `description` or ICE `candidate`).
     - `chat {message}` → broadcast to room with `{from, name, message, ts}`. Server truncates to 2000 chars.
     - `rename {name}` → re-broadcasts `peers`.
     - `disconnect` → notifies remaining peers via `peer-left`.
   - The signaling path **must stay media-blind** — adding realtime media handling here would break the P2P assumption.

2. **`POST /api/summarize`** — a separate, request/response path that handles **already-finished** audio:
   - Receives a single multipart `audio` field (max 25 MB — Whisper's hard limit). Uses `multer` with `memoryStorage`.
   - Step 1: forwards the blob to **OpenAI Whisper** (`whisper-1`) via `fetch` using Node 18+ native `FormData` / `Blob` (no `form-data` package).
   - Step 2: feeds the transcript to **Anthropic Claude** (`claude-opus-4-7`, adaptive thinking, streaming via `messages.stream()` + `finalMessage()`). The system prompt is wrapped in a `cache_control: {type: "ephemeral"}` block so repeated calls hit the cache.
   - Returns `{transcript, summary, usage}` JSON.
   - Requires env vars `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Missing keys → 503 with a structured `{error, message}` body — the client surfaces these directly.
   - **This path is not P2P-aware.** It accepts any audio blob from any caller; rooms and socket IDs do not enter the picture. Don't try to wire it into the signaling layer.

Why this split matters: realtime media never crosses the server (P2P mesh). The summarize endpoint only handles a recording the browser *already produced*, so adding it doesn't violate the "server is media-blind during the call" invariant. If you change the system prompt in `SUMMARY_SYSTEM_PROMPT`, keep the section headings in Thai — they're part of the contract the client renders and a downstream user might rely on them in the downloaded `.md`.

### `public/index.html` — full client (UI + WebRTC) in one file

Single self-contained file: CSS, HTML, and an IIFE module. The structure that matters:

- **`peers: Map<remoteId, {pc, name, polite, makingOffer, ignoreOffer, videoSender, audioSender, mic, cam, sharing, handRaised}>`** — one `RTCPeerConnection` per remote participant (mesh). The `videoSender`/`audioSender` references are kept so that screen-share and mute toggles can `replaceTrack()` instead of renegotiating from scratch. The four state flags (`mic`/`cam`/`sharing`/`handRaised`) are kept in sync by the server's `state` event and rendered as badges via `renderTileState(id)`.
- **Room-level state is server-authoritative.** The server holds `rooms: Map<roomId, {hostId, peers: Map<id, {name, mic, cam, sharing, handRaised}>}>` and broadcasts `peers {hostId, peers: [...]}` on any change. Clients merge that broadcast into their local `peers` Map — they never set another peer's state themselves. The first joiner becomes host; if the host leaves, the oldest remaining peer is promoted (Map preserves insertion order).
- **Host-only `force-mute`** is enforced server-side: the host emits `force-mute {to}`, the server checks `room.hostId === socket.id`, then sends `forced-mute` to the target. The target client mutes locally and emits the resulting `state {mic: false}` so everyone's UI converges. The mute is *not* permanent — the target can unmute themselves with the mic button as usual; this matches Zoom behavior.
- **View modes** (`viewMode`, `gridSize`, `pinnedSpotlightId`) live in `localStorage` under `mr_view_mode` / `mr_grid_size`. `applyViewMode()` toggles CSS classes (`mode-grid` + `size-{small,medium,large}` or `mode-spotlight`) on `#videos`; in spotlight mode it sets `.spotlighted` on the right tile. **Auto-spotlight**: if any peer (incl. self) is sharing, `getEffectiveSpotlightId()` forces spotlight layout regardless of the chosen view mode — this is a hard product requirement (sharer's screen must be visible as the large tile). Manual clicks on a tile in spotlight mode pin/unpin it via `pinnedSpotlightId`, overriding the auto behavior until cleared.
- **Reactions** are server-relayed (`reaction {emoji}` → server broadcasts `{from, emoji, ts}` to room). `flyReaction(tileId, emoji)` injects a `<span class="reaction-fly">` into the target tile's `.reaction-layer` and the `floatUp` keyframe handles the animation; the element is removed after the 2.4s animation.
- **Video filters** apply both locally (cheap, via CSS `filter:` on the `<video>` element) and to the outbound stream (via a canvas pipeline). The canvas pipeline keeps a hidden `<video>` element bound to `cameraStream`, draws frames to a hidden `<canvas>` with `ctx.filter = FILTER_CSS[name]` on each `requestAnimationFrame`, captures the canvas at 30fps via `captureStream()`, and replaces every peer's outbound `videoSender.replaceTrack(filteredTrack)`. When screen sharing starts, the pipeline is suspended (`stopFilterPipeline()`) because the screen track owns the sender; `stopShare()` re-applies the filter on its way out. With no filter active, no canvas runs — CPU stays at baseline.
- **Who initiates an offer**: the *newcomer* calls `createPeer(..., isInitiator=true)` for each peer in the `peers` array returned by `join` ack. Existing peers receive `peer-joined` and create the connection with `isInitiator=false`. The `polite = !isInitiator` flag drives the **perfect-negotiation pattern** (`makingOffer` / `ignoreOffer` / collision check in `handleSignal`) — keep this invariant intact when adding renegotiation paths.
- **Screen share** preserves `cameraStream` and swaps only the outbound video track via `videoSender.replaceTrack(screenTrack)`. When the user stops sharing (or the browser ends the capture via `screenTrack.onended`), it swaps back to the camera track. This is why the camera stream is held in a separate variable from `localStream`.
- **Recording runs two `MediaRecorder` instances in parallel:**
  - `recorder` records `buildMixedRecordStream()` — local video + local audio + every remote tile's audio — producing a video+audio `.webm` for download.
  - `audioRecorder` records `buildAudioOnlyStream()` — same audio tracks, no video — producing a much smaller `.webm` used as the upload to `/api/summarize`. The two recorders share underlying tracks, so CPU overhead is minimal; the audio-only file matters because Whisper has a hard **25 MB** request limit and a video file blows past that within a few minutes.
  - When **both** recorders fire `onstop`, `maybeOpenRecModal()` opens the post-recording dialog with two actions: "Download video" (the mixed `.webm`) and "Summarize with AI" (POSTs the audio-only blob, then renders the returned Markdown summary and offers a `.md` download). The `_modalOpenedForThisRecording` latch prevents the modal from opening twice if both `onstop` callbacks race.
- **Recording is still browser-side** (not server-side recording). The server only sees the audio when the user explicitly clicks "Summarize" after the meeting ends.
- **ICE servers** are declared in `rtcConfig` (Google STUN only). For production behind symmetric NAT, add a TURN entry here — there is no env-var plumbing for this, intentionally, because it's static client config.
- **URL state**: room code is reflected into `?room=` and the display name is cached in `localStorage` under `mr_name` — preserve these when changing the lobby flow.

### `package.json`

Pinned to `express ^4` and `socket.io ^4`. Do not upgrade `socket.io` major without updating the `<script src="/socket.io/socket.io.js">` consumer side — the client library is served by socket.io itself and protocol versions must match.

Additional deps for the summarize endpoint:
- `@anthropic-ai/sdk ^0.40` — Claude. The summarize handler uses `messages.stream()` + `await stream.finalMessage()` rather than `messages.create()` to avoid HTTP timeouts on long transcripts (per Anthropic SDK guidance for long-input requests).
- `multer ^1.4.5-lts` — multipart upload parsing into memory (`memoryStorage`), with a hard 25 MB limit set in `server.js` to match Whisper's request cap.
- **No OpenAI SDK** — Whisper is called directly with `fetch` + Node 18's native `FormData`/`Blob`. Don't add `openai` as a dep just for one endpoint.

## Deployment notes that affect code decisions

- Browsers refuse `getUserMedia` over plain HTTP except on `localhost`. Any deploy target needs HTTPS terminating in front of the Node process. The server itself does **not** terminate TLS — Render/Railway/Nginx is expected to.
- When proxying (e.g. Nginx), WebSocket upgrade headers must be forwarded or Socket.io silently falls back to long-polling. The client already requests `transports: ['websocket', 'polling']`.
- Mesh topology means **upload bandwidth scales linearly with peer count**. Don't add features that multiply outbound streams (e.g. simulcast layers) without first introducing an SFU.
- `render.yaml` declares `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` with `sync: false` so Render prompts the operator to set them at deploy time. The summarize endpoint degrades gracefully (returns 503 with a structured error the client renders) if either is missing — do not change this to a hard crash on startup; the room-call functionality must work even without keys configured.
