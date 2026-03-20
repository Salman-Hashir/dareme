// ════════════════════════════════════════════════════
//  DARE.ME — Backend Server v2
//  Random match + Group expand + Kick voting
// ════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'DARE.ME server running 🎲', online: getOnlineCount(), groups: Object.keys(groups).length });
});

// ════════════════ STATE ════════════════
let waitingQueue = [];
const pairs      = {};   // { socketId: partnerId }
const userVibes  = {};
const groups     = {};   // { roomId: { members, expandVotes, kickVotes } }
const socketRoom = {};   // { socketId: roomId }
const privateWaiting = {};

// ════════════════ HELPERS ════════════════
function getOnlineCount() {
  const g = Object.values(groups).reduce((n, gr) => n + gr.members.length, 0);
  return g + Object.keys(pairs).length + waitingQueue.length;
}
function broadcastCount() { io.emit('online-count', getOnlineCount()); }
function makeId() { return Math.random().toString(36).substring(2,8).toUpperCase(); }

function matchPair(idA, idB) {
  pairs[idA] = idB; pairs[idB] = idA;
  io.to(idA).emit('matched', { role: 'initiator' });
  io.to(idB).emit('matched', { role: 'receiver' });
  console.log(`✅ Pair: ${idA.slice(0,6)} ↔ ${idB.slice(0,6)}`);
}

function cleanupSocket(socketId) {
  const partner = pairs[socketId];
  if (partner) { io.to(partner).emit('partner-disconnected'); delete pairs[partner]; }
  delete pairs[socketId];
  waitingQueue = waitingQueue.filter(id => id !== socketId);
  const roomId = socketRoom[socketId];
  if (roomId && groups[roomId]) leaveGroup(socketId, roomId);
  delete socketRoom[socketId];
  for (const code of Object.keys(privateWaiting)) {
    if (privateWaiting[code] === socketId) delete privateWaiting[code];
  }
}

function leaveGroup(socketId, roomId) {
  const g = groups[roomId];
  if (!g) return;
  g.members = g.members.filter(id => id !== socketId);
  delete socketRoom[socketId];
  if (g.expandVotes) g.expandVotes = null;
  if (g.kickVotes && (g.kickVotes.targetId === socketId || g.kickVotes.votes.has(socketId))) g.kickVotes = null;
  if (g.members.length === 0) { delete groups[roomId]; return; }
  g.members.forEach(id => io.to(id).emit('member-left', { socketId, members: g.members }));
  broadcastGroupState(roomId);
}

function broadcastGroupState(roomId) {
  const g = groups[roomId];
  if (!g) return;
  const needed = g.members.length === 3 ? 2 : 3;
  g.members.forEach(id => io.to(id).emit('group-state', {
    roomId, members: g.members, count: g.members.length, canExpand: g.members.length < 4,
    expandVotes: g.expandVotes ? { requesterId: g.expandVotes.requesterId, votes: [...g.expandVotes.votes].length, needed: g.members.length } : null,
    kickVotes: g.kickVotes ? { targetId: g.kickVotes.targetId, votes: [...g.kickVotes.votes].length, needed } : null
  }));
}

// ════════════════ SOCKET ════════════════
io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id.slice(0,6)} connected`);
  broadcastCount();

  socket.on('join-queue', ({ vibe }) => {
    userVibes[socket.id] = vibe || 'chill';
    waitingQueue = waitingQueue.filter(id => id !== socket.id);
    if (waitingQueue.length > 0) { matchPair(socket.id, waitingQueue.shift()); }
    else { waitingQueue.push(socket.id); socket.emit('waiting'); }
    broadcastCount();
  });

  socket.on('webrtc-offer', ({ offer, to }) => {
    const target = to || pairs[socket.id];
    if (target) io.to(target).emit('webrtc-offer', { offer, from: socket.id });
  });
  socket.on('webrtc-answer', ({ answer, to }) => {
    const target = to || pairs[socket.id];
    if (target) io.to(target).emit('webrtc-answer', { answer, from: socket.id });
  });
  socket.on('ice-candidate', ({ candidate, to }) => {
    const target = to || pairs[socket.id];
    if (target) io.to(target).emit('ice-candidate', { candidate, from: socket.id });
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socketRoom[socket.id];
    if (roomId && groups[roomId]) {
      groups[roomId].members.filter(id => id !== socket.id).forEach(id => io.to(id).emit('chat-message', { text, from: socket.id }));
    } else {
      const p = pairs[socket.id]; if (p) io.to(p).emit('chat-message', { text, from: socket.id });
    }
  });

  socket.on('td-question', ({ type, question }) => {
    const roomId = socketRoom[socket.id];
    if (roomId && groups[roomId]) {
      groups[roomId].members.filter(id => id !== socket.id).forEach(id => io.to(id).emit('td-question', { type, question }));
    } else {
      const p = pairs[socket.id]; if (p) io.to(p).emit('td-question', { type, question });
    }
  });

  // ── EXPAND GROUP REQUEST ──
  socket.on('expand-request', () => {
    const partner = pairs[socket.id];
    if (!partner) return;
    const roomId = makeId();
    groups[roomId] = { members: [socket.id, partner], expandVotes: { requesterId: socket.id, votes: new Set([socket.id]) }, kickVotes: null };
    socketRoom[socket.id] = roomId;
    socketRoom[partner] = roomId;
    delete pairs[socket.id]; delete pairs[partner];
    socket.emit('expand-requested', { roomId, from: socket.id });
    io.to(partner).emit('expand-requested', { roomId, from: socket.id });
    broadcastGroupState(roomId);
    console.log(`➕ Expand requested room ${roomId}`);
  });

  // ── EXPAND VOTE ──
  socket.on('expand-vote', ({ roomId, agree }) => {
    const g = groups[roomId];
    if (!g || !g.expandVotes || !g.members.includes(socket.id)) return;
    if (!agree) {
      g.expandVotes = null;
      g.members.forEach(id => io.to(id).emit('expand-declined', { by: socket.id }));
      broadcastGroupState(roomId); return;
    }
    g.expandVotes.votes.add(socket.id);
    if (g.expandVotes.votes.size >= g.members.length) {
      g.expandVotes = null;
      if (waitingQueue.length > 0) {
        const newMember = waitingQueue.shift();
        g.members.push(newMember);
        socketRoom[newMember] = roomId;
        g.members.forEach(id => io.to(id).emit('member-joined', { newMember, members: g.members }));
        io.to(newMember).emit('group-joined', { roomId, members: g.members });
        console.log(`➕ ${newMember.slice(0,6)} joined group ${roomId} (${g.members.length} people)`);
      } else {
        g.members.forEach(id => io.to(id).emit('expand-no-stranger'));
      }
      broadcastGroupState(roomId); broadcastCount();
    } else { broadcastGroupState(roomId); }
  });

  // ── KICK VOTE START ──
  socket.on('kick-vote', ({ targetId }) => {
    const roomId = socketRoom[socket.id];
    const g = groups[roomId];
    if (!g || !g.members.includes(targetId) || g.kickVotes) return;
    g.kickVotes = { targetId, votes: new Set([socket.id]) };
    const needed = g.members.length === 3 ? 2 : 3;
    g.members.forEach(id => io.to(id).emit('kick-vote-started', { targetId, by: socket.id, votes: 1, needed }));
    broadcastGroupState(roomId);
  });

  // ── KICK VOTE CAST ──
  socket.on('kick-vote-cast', ({ roomId, agree }) => {
    const g = groups[roomId];
    if (!g || !g.kickVotes || !g.members.includes(socket.id) || socket.id === g.kickVotes.targetId) return;
    if (agree) g.kickVotes.votes.add(socket.id);
    const needed = g.members.length === 3 ? 2 : 3;
    const current = g.kickVotes.votes.size;
    g.members.forEach(id => io.to(id).emit('kick-vote-update', { targetId: g.kickVotes.targetId, votes: current, needed }));
    if (current >= needed) {
      const kickedId = g.kickVotes.targetId;
      g.kickVotes = null;
      io.to(kickedId).emit('you-were-kicked');
      leaveGroup(kickedId, roomId);
      delete socketRoom[kickedId];
      console.log(`🚫 Kicked ${kickedId.slice(0,6)} from ${roomId}`);
    }
    if (g.members && g.members.length > 0) broadcastGroupState(roomId);
    broadcastCount();
  });

  socket.on('next', () => {
    cleanupSocket(socket.id);
    if (waitingQueue.length > 0) { matchPair(socket.id, waitingQueue.shift()); }
    else { waitingQueue.push(socket.id); socket.emit('waiting'); }
    broadcastCount();
  });

  socket.on('join-private-room', ({ code }) => {
    const key = code.toUpperCase();
    if (privateWaiting[key]) {
      const partnerId = privateWaiting[key]; delete privateWaiting[key];
      matchPair(socket.id, partnerId);
      io.to(socket.id).emit('private-room-matched', { role: 'receiver' });
      io.to(partnerId).emit('private-room-matched', { role: 'initiator' });
    } else { privateWaiting[key] = socket.id; socket.emit('waiting'); }
    broadcastCount();
  });

  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id.slice(0,6)} disconnected`);
    cleanupSocket(socket.id); delete userVibes[socket.id]; broadcastCount();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗\n  ║   DARE.ME Server v2 Running 🎲   ║\n  ║   Port: ${PORT}                     ║\n  ╚══════════════════════════════════╝\n`);
});
