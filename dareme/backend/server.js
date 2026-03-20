// ════════════════════════════════════════════════════
//  DARE.ME — Backend Server
//  Socket.io signaling + random matching
// ════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ── CORS: allow your Vercel frontend URL ──
const io = new Server(server, {
  cors: {
    origin: '*', // In production, replace with your Vercel URL e.g. "https://dareme.vercel.app"
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// ── Health check endpoint (Render needs this) ──
app.get('/', (req, res) => {
  res.json({
    status: 'DARE.ME server running 🎲',
    online: Object.keys(activePairs).length * 2 + waitingQueue.length,
    pairs: Object.keys(activePairs).length
  });
});

// ════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════

let waitingQueue = [];       // socket IDs waiting for a match
const activePairs = {};      // { socketId: partnerSocketId }
const userVibes = {};        // { socketId: 'chill'|'spicy'|'wild' }

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════

function getOnlineCount() {
  return Object.keys(activePairs).length + waitingQueue.length;
}

function matchUsers(socketA, socketB) {
  // Record the pair both ways
  activePairs[socketA] = socketB;
  activePairs[socketB] = socketA;

  // Tell both users they are matched
  // The one who gets 'matched-initiator' will create the WebRTC offer
  io.to(socketA).emit('matched', { role: 'initiator', partnerId: socketB });
  io.to(socketB).emit('matched', { role: 'receiver',  partnerId: socketA });

  console.log(`✅ Matched: ${socketA.slice(0,6)} ↔ ${socketB.slice(0,6)}`);
}

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
}

function disconnectPair(socketId) {
  const partnerId = activePairs[socketId];
  if (partnerId) {
    io.to(partnerId).emit('partner-disconnected');
    delete activePairs[partnerId];
  }
  delete activePairs[socketId];
  removeFromQueue(socketId);
}

// ════════════════════════════════════════════════════
//  SOCKET EVENTS
// ════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id.slice(0,6)}... [Total: ${io.engine.clientsCount}]`);

  // Broadcast updated online count to everyone
  io.emit('online-count', getOnlineCount());

  // ── JOIN QUEUE ──────────────────────────────────
  socket.on('join-queue', ({ vibe }) => {
    // Store vibe preference
    userVibes[socket.id] = vibe || 'chill';

    // Remove if already in queue (re-join)
    removeFromQueue(socket.id);

    // If someone is already waiting → match them
    if (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      matchUsers(socket.id, partnerId);
    } else {
      // Otherwise wait in queue
      waitingQueue.push(socket.id);
      socket.emit('waiting');
      console.log(`⏳ Waiting: ${socket.id.slice(0,6)} | Queue: ${waitingQueue.length}`);
    }

    io.emit('online-count', getOnlineCount());
  });

  // ── WEBRTC SIGNALING ────────────────────────────
  // Relay offer from initiator to receiver
  socket.on('webrtc-offer', ({ offer }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('webrtc-offer', { offer, from: socket.id });
    }
  });

  // Relay answer from receiver to initiator
  socket.on('webrtc-answer', ({ answer }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('webrtc-answer', { answer });
    }
  });

  // Relay ICE candidates between peers
  socket.on('ice-candidate', ({ candidate }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('ice-candidate', { candidate });
    }
  });

  // ── CHAT MESSAGES ───────────────────────────────
  socket.on('chat-message', ({ text }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId && text && text.trim()) {
      io.to(partnerId).emit('chat-message', { text: text.trim() });
    }
  });

  // ── TRUTH OR DARE (notify partner) ──────────────
  socket.on('td-question', ({ type, question, vibe }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('td-question', { type, question, vibe });
    }
  });

  // ── PRIVATE ROOM ────────────────────────────────
  socket.on('join-private-room', ({ code }) => {
    const roomKey = 'private_' + code.toUpperCase();
    if (!waitingQueue.includes(roomKey + ':' + socket.id)) {
      // Check if someone already waiting in this room
      const existing = waitingQueue.find(id => id.startsWith(roomKey + ':'));
      if (existing) {
        const partnerId = existing.split(':')[1];
        waitingQueue = waitingQueue.filter(id => id !== existing);
        matchUsers(socket.id, partnerId);
        io.to(socket.id).emit('private-room-matched', { role: 'receiver' });
        io.to(partnerId).emit('private-room-matched', { role: 'initiator' });
      } else {
        waitingQueue.push(roomKey + ':' + socket.id);
        socket.emit('waiting');
      }
    }
    io.emit('online-count', getOnlineCount());
  });

  // ── GROUP ROOM (up to 4) ────────────────────────
  socket.on('join-group-room', ({ code, maxPeers }) => {
    const roomKey = 'group_' + code.toUpperCase();
    // Find others in this group room
    const inRoom = Object.keys(activePairs).filter(id => activePairs[id] && activePairs[id].startsWith && activePairs[id].startsWith(roomKey));
    socket.join(roomKey);
    // Notify everyone in room
    io.to(roomKey).emit('group-room-update', {
      peers: io.sockets.adapter.rooms.get(roomKey)?.size || 1,
      code: code.toUpperCase()
    });
    // Pair with first available person in room for WebRTC
    const roomMembers = [...(io.sockets.adapter.rooms.get(roomKey) || [])].filter(id => id !== socket.id);
    if (roomMembers.length > 0) {
      const partnerId = roomMembers[0];
      matchUsers(socket.id, partnerId);
    } else {
      socket.emit('waiting');
    }
    io.emit('online-count', getOnlineCount());
  });

  // ── GROUP INVITE ─────────────────────────────────
  socket.on('group-invite', ({ code }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) io.to(partnerId).emit('group-invite', { code });
  });

  socket.on('group-invite-accept', ({ code }) => {
    const partnerId = activePairs[socket.id];
    if (partnerId) io.to(partnerId).emit('group-invite-accept', { code });
  });

  socket.on('next', () => {
    disconnectPair(socket.id);
    // Immediately re-join queue
    if (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      matchUsers(socket.id, partnerId);
    } else {
      waitingQueue.push(socket.id);
      socket.emit('waiting');
    }
    io.emit('online-count', getOnlineCount());
  });

  // ── DISCONNECT ──────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id.slice(0,6)}`);
    disconnectPair(socket.id);
    delete userVibes[socket.id];
    io.emit('online-count', getOnlineCount());
  });
});

// ════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   DARE.ME Server Running 🎲      ║
  ║   Port: ${PORT}                     ║
  ╚══════════════════════════════════╝
  `);
});
