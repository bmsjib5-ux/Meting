const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

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
