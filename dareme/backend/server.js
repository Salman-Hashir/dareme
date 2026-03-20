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

  // ── NEXT STRANGER ───────────────────────────────
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
