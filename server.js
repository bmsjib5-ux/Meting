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
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function broadcastPeers(roomId) {
  const room = getRoom(roomId);
  const peers = Array.from(room.entries()).map(([id, info]) => ({ id, name: info.name }));
  io.to(roomId).emit('peers', peers);
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || typeof roomId !== 'string') {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_room' });
      return;
    }
    const displayName = (name && String(name).trim()) || 'Guest';
    joinedRoom = roomId;
    socket.join(roomId);

    const room = getRoom(roomId);
    room.set(socket.id, { name: displayName });

    const existing = Array.from(room.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, name: info.name }));

    if (typeof ack === 'function') ack({ ok: true, selfId: socket.id, peers: existing });

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
    const info = room.get(socket.id);
    const name = info ? info.name : 'Guest';
    io.to(joinedRoom).emit('chat', {
      from: socket.id,
      name,
      message: String(message).slice(0, 2000),
      ts: Date.now(),
    });
  });

  socket.on('rename', ({ name }) => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    const info = room.get(socket.id);
    if (!info) return;
    info.name = (name && String(name).trim()) || info.name;
    broadcastPeers(joinedRoom);
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    room.delete(socket.id);
    socket.to(joinedRoom).emit('peer-left', { id: socket.id });
    if (room.size === 0) rooms.delete(joinedRoom);
    else broadcastPeers(joinedRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`▶ Running on: http://localhost:${PORT}`);
});
