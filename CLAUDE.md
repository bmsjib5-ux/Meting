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

### `server.js` — signaling only, never sees media

- Express serves `public/`. Socket.io is mounted on the same HTTP server (clients load `/socket.io/socket.io.js` automatically).
- In-memory `rooms: Map<roomId, Map<socketId, {name}>>`. No persistence — restarting the server drops all rooms. The room entry is deleted when the last peer leaves.
- Socket events form the wire protocol with the browser; **the names below are load-bearing** — clients hard-code them:
  - `join {roomId, name}` → ack `{ok, selfId, peers}`; server emits `peer-joined` to others and `peers` (full roster) to room.
  - `signal {to, data}` → relayed verbatim to `to` as `signal {from, data}`. `data` is opaque to the server (carries SDP `description` or ICE `candidate`).
  - `chat {message}` → broadcast to room with `{from, name, message, ts}`. Server truncates to 2000 chars.
  - `rename {name}` → re-broadcasts `peers`.
  - `disconnect` → notifies remaining peers via `peer-left`.

The server **must stay media-blind** — adding media handling here breaks the P2P assumption. Anything that should affect everyone in a room goes through `io.to(roomId).emit(...)`; anything peer-to-peer goes through `signal` relay.

### `public/index.html` — full client (UI + WebRTC) in one file

Single self-contained file: CSS, HTML, and an IIFE module. The structure that matters:

- **`peers: Map<remoteId, {pc, name, polite, makingOffer, ignoreOffer, videoSender, audioSender}>`** — one `RTCPeerConnection` per remote participant (mesh). The `videoSender`/`audioSender` references are kept so that screen-share and mute toggles can `replaceTrack()` instead of renegotiating from scratch.
- **Who initiates an offer**: the *newcomer* calls `createPeer(..., isInitiator=true)` for each peer in the `peers` array returned by `join` ack. Existing peers receive `peer-joined` and create the connection with `isInitiator=false`. The `polite = !isInitiator` flag drives the **perfect-negotiation pattern** (`makingOffer` / `ignoreOffer` / collision check in `handleSignal`) — keep this invariant intact when adding renegotiation paths.
- **Screen share** preserves `cameraStream` and swaps only the outbound video track via `videoSender.replaceTrack(screenTrack)`. When the user stops sharing (or the browser ends the capture via `screenTrack.onended`), it swaps back to the camera track. This is why the camera stream is held in a separate variable from `localStream`.
- **Recording** uses `MediaRecorder` against a **client-side mixed `MediaStream`** built in `buildMixedRecordStream()`: the local video + local audio + every remote tile's audio tracks. Output is a `.webm` Blob downloaded via an `<a download>` link — **recording is browser-side, not server-side**, and only captures audio from remotes (not their video).
- **ICE servers** are declared in `rtcConfig` (Google STUN only). For production behind symmetric NAT, add a TURN entry here — there is no env-var plumbing for this, intentionally, because it's static client config.
- **URL state**: room code is reflected into `?room=` and the display name is cached in `localStorage` under `mr_name` — preserve these when changing the lobby flow.

### `package.json`

Pinned to `express ^4` and `socket.io ^4`. Do not upgrade `socket.io` major without updating the `<script src="/socket.io/socket.io.js">` consumer side — the client library is served by socket.io itself and protocol versions must match.

## Deployment notes that affect code decisions

- Browsers refuse `getUserMedia` over plain HTTP except on `localhost`. Any deploy target needs HTTPS terminating in front of the Node process. The server itself does **not** terminate TLS — Render/Railway/Nginx is expected to.
- When proxying (e.g. Nginx), WebSocket upgrade headers must be forwarded or Socket.io silently falls back to long-polling. The client already requests `transports: ['websocket', 'polling']`.
- Mesh topology means **upload bandwidth scales linearly with peer count**. Don't add features that multiply outbound streams (e.g. simulcast layers) without first introducing an SFU.
