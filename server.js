const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const SUMMARY_SYSTEM_PROMPT = `You are a meeting-notes assistant. Given a meeting transcript, produce a structured summary in the same primary language as the transcript (auto-detect; default to Thai if the transcript mixes Thai and English).

Output Markdown with these sections in this order:

## สรุปสั้น (TL;DR)
A single short paragraph (2-3 sentences).

## ประเด็นหลัก (Key points)
Bullet list of the most important discussion points.

## การตัดสินใจ (Decisions)
Bullet list of decisions that were actually made, or "ไม่มี" if none.

## งานที่ต้องทำ (Action items)
Bullet list, each in the format: "- [ ] <task> — <owner if mentioned> — <due date if mentioned>". Output "ไม่มี" if none.

## คำถามที่ยังค้าง (Open questions)
Bullet list of unresolved questions, or "ไม่มี".

Rules:
- Be strictly faithful to the transcript. Do not invent names, numbers, dates, or decisions that are not present.
- Keep proper nouns, numbers, and dates exactly as spoken.
- If the transcript is very short or empty, say so clearly instead of fabricating content.
- Match the section headings exactly — they are part of the contract.`;

app.post('/api/summarize', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_audio' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'missing_openai_key', message: 'Server is missing OPENAI_API_KEY env var.' });
    }
    if (!anthropic) {
      return res.status(503).json({ error: 'missing_anthropic_key', message: 'Server is missing ANTHROPIC_API_KEY env var.' });
    }

    const form = new FormData();
    const filename = req.file.originalname || 'audio.webm';
    const mime = req.file.mimetype || 'audio/webm';
    form.append('file', new Blob([req.file.buffer], { type: mime }), filename);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    const lang = (req.body.language || '').trim();
    if (lang) form.append('language', lang);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!whisperRes.ok) {
      const detail = await whisperRes.text();
      console.error('whisper failed', whisperRes.status, detail);
      return res.status(502).json({ error: 'whisper_failed', status: whisperRes.status, detail });
    }
    const { text: transcript } = await whisperRes.json();

    if (!transcript || !transcript.trim()) {
      return res.json({ transcript: '', summary: '_(ไม่พบเสียงพูดในไฟล์ที่ส่งมา)_' });
    }

    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: SUMMARY_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Transcript of the meeting:\n\n${transcript}`,
        },
      ],
    });
    const finalMessage = await stream.finalMessage();
    const summary = finalMessage.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    res.json({
      transcript,
      summary,
      usage: finalMessage.usage,
    });
  } catch (err) {
    console.error('summarize error', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { hostId: null, peers: new Map() });
  }
  return rooms.get(roomId);
}

function peerSnapshot(room) {
  return Array.from(room.peers.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    mic: info.mic,
    cam: info.cam,
    sharing: info.sharing,
    handRaised: info.handRaised,
  }));
}

function broadcastPeers(roomId) {
  const room = getRoom(roomId);
  io.to(roomId).emit('peers', { hostId: room.hostId, peers: peerSnapshot(room) });
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || typeof roomId !== 'string') {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_room', message: 'รหัสห้องไม่ถูกต้อง' });
      return;
    }
    const displayName = name && String(name).trim();
    if (!displayName) {
      if (typeof ack === 'function') ack({ ok: false, error: 'name_required', message: 'กรุณาใส่ชื่อก่อนเข้าห้อง' });
      return;
    }
    if (displayName.length > 40) {
      if (typeof ack === 'function') ack({ ok: false, error: 'name_too_long', message: 'ชื่อยาวเกินไป (สูงสุด 40 ตัวอักษร)' });
      return;
    }

    // Case-insensitive duplicate check — only against an already-existing room
    // so failed joins don't leave behind empty rooms.
    const existing = rooms.get(roomId);
    if (existing) {
      const lower = displayName.toLowerCase();
      for (const info of existing.peers.values()) {
        if (info.name.toLowerCase() === lower) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'name_taken', message: `ชื่อ "${displayName}" มีคนใช้อยู่ในห้องนี้แล้ว — กรุณาเลือกชื่ออื่น` });
          }
          return;
        }
      }
    }

    joinedRoom = roomId;
    socket.join(roomId);

    const room = getRoom(roomId);
    room.peers.set(socket.id, {
      name: displayName,
      mic: true,
      cam: true,
      sharing: false,
      handRaised: false,
    });
    if (!room.hostId) room.hostId = socket.id;

    const peers = peerSnapshot(room).filter((p) => p.id !== socket.id);

    if (typeof ack === 'function') {
      ack({ ok: true, selfId: socket.id, hostId: room.hostId, peers });
    }

    socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName });
    broadcastPeers(roomId);
  });

  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ message }) => {
    if (!joinedRoom || !message) return;
    const room = getRoom(joinedRoom);
    const info = room.peers.get(socket.id);
    const name = info ? info.name : 'Guest';
    io.to(joinedRoom).emit('chat', {
      from: socket.id,
      name,
      message: String(message).slice(0, 2000),
      ts: Date.now(),
    });
  });

  socket.on('rename', ({ name }, ack) => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    const info = room.peers.get(socket.id);
    if (!info) return;
    const trimmed = name && String(name).trim();
    if (!trimmed || trimmed.length > 40) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_name' });
      return;
    }
    const lower = trimmed.toLowerCase();
    for (const [id, other] of room.peers) {
      if (id !== socket.id && other.name.toLowerCase() === lower) {
        if (typeof ack === 'function') ack({ ok: false, error: 'name_taken' });
        return;
      }
    }
    info.name = trimmed;
    if (typeof ack === 'function') ack({ ok: true });
    broadcastPeers(joinedRoom);
  });

  socket.on('state', (patch) => {
    if (!joinedRoom || !patch || typeof patch !== 'object') return;
    const room = getRoom(joinedRoom);
    const info = room.peers.get(socket.id);
    if (!info) return;
    for (const key of ['mic', 'cam', 'sharing', 'handRaised']) {
      if (typeof patch[key] === 'boolean') info[key] = patch[key];
    }
    broadcastPeers(joinedRoom);
  });

  socket.on('force-mute', ({ to }) => {
    if (!joinedRoom || !to) return;
    const room = getRoom(joinedRoom);
    if (room.hostId !== socket.id) return; // only host may force-mute
    if (!room.peers.has(to)) return;
    io.to(to).emit('forced-mute', { from: socket.id });
  });

  socket.on('reaction', ({ emoji }) => {
    if (!joinedRoom || typeof emoji !== 'string') return;
    const clean = emoji.slice(0, 8);
    io.to(joinedRoom).emit('reaction', { from: socket.id, emoji: clean, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    const wasHost = room.hostId === socket.id;
    room.peers.delete(socket.id);

    if (room.peers.size === 0) {
      rooms.delete(joinedRoom);
      return;
    }

    if (wasHost) {
      // Promote the oldest remaining peer to host (Map preserves insertion order)
      room.hostId = room.peers.keys().next().value;
    }

    socket.to(joinedRoom).emit('peer-left', { id: socket.id });
    broadcastPeers(joinedRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`▶ Running on: http://localhost:${PORT}`);
});
