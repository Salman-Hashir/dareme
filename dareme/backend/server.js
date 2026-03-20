// ════════════════════════════════════════════════════
//  DARE.ME — Backend Server v3
//  1-to-1 match + Open group rooms + Private rooms
// ════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.json({
  status: 'DARE.ME v3 🎲',
  online: getOnlineCount(),
  openGroups: Object.values(groups).filter(g => g.open && g.members.length < 4).length
}));

// ════════════════════════════ STATE ════════════════════════════
let randomQueue   = [];   // waiting for 1-to-1
let groupQueue    = [];   // waiting to join any open group
const pairs       = {};   // { socketId: partnerId }
const socketRoom  = {};   // { socketId: roomId }

// groups[roomId] = {
//   members  : [socketId, ...],   max 4
//   open     : bool,              true = auto-join allowed
//   private  : bool,              true = code-only access
//   code     : string,
//   kickVotes: { targetId, votes: Set }
// }
const groups = {};
const privateWaiting = {};  // { code: socketId }

// ════════════════════════════ HELPERS ════════════════════════════
function getOnlineCount() {
  const inGroups = Object.values(groups).reduce((n, g) => n + g.members.length, 0);
  return inGroups + Object.keys(pairs).length + randomQueue.length + groupQueue.length;
}

function broadcast() { io.emit('online-count', getOnlineCount()); }

function makeCode(len = 6) {
  return Math.random().toString(36).substring(2, 2 + len).toUpperCase();
}

// Match two people 1-to-1
function matchPair(idA, idB) {
  pairs[idA] = idB;
  pairs[idB] = idA;
  io.to(idA).emit('matched', { role: 'initiator' });
  io.to(idB).emit('matched', { role: 'receiver' });
  console.log(`✅ Pair: ${idA.slice(0,6)} ↔ ${idB.slice(0,6)}`);
}

// Create a group room from two paired people
function convertToGroup(idA, idB) {
  // Remove from pairs
  delete pairs[idA];
  delete pairs[idB];

  const code = makeCode(6);
  const roomId = 'grp_' + code;

  groups[roomId] = {
    members  : [idA, idB],
    open     : true,       // anyone can auto-join
    private  : false,
    code,
    kickVotes: null
  };

  socketRoom[idA] = roomId;
  socketRoom[idB] = roomId;

  // Notify both — group mode on, show code in chat
  io.to(idA).emit('group-opened', { roomId, code, members: [idA, idB], myId: idA });
  io.to(idB).emit('group-opened', { roomId, code, members: [idA, idB], myId: idB });

  // Check if anyone in groupQueue waiting
  tryFillGroup(roomId);

  console.log(`👥 Group ${code} created: ${idA.slice(0,6)} + ${idB.slice(0,6)}`);
  broadcast();
  return roomId;
}

// Try to pull next person from groupQueue into an open group
function tryFillGroup(roomId) {
  const g = groups[roomId];
  if (!g || !g.open || g.members.length >= 4) return;
  if (groupQueue.length === 0) return;

  const newId = groupQueue.shift();
  addToGroup(newId, roomId);
}

// Add a socket to an existing group
function addToGroup(socketId, roomId) {
  const g = groups[roomId];
  if (!g || g.members.length >= 4) return false;

  g.members.push(socketId);
  socketRoom[socketId] = roomId;

  const existingMembers = g.members.filter(id => id !== socketId);

  // Tell new member
  io.to(socketId).emit('group-joined', {
    roomId,
    code    : g.code,
    members : g.members,
    myId    : socketId,
    isPrivate: g.private
  });

  // Tell existing members
  existingMembers.forEach(id => {
    io.to(id).emit('member-joined', { newMember: socketId, members: g.members });
  });

  // Close group if full
  if (g.members.length >= 4) {
    g.open = false;
    g.members.forEach(id => io.to(id).emit('group-full', { members: g.members }));
    console.log(`👥 Group ${g.code} full (4/4)`);
  }

  broadcastGroupState(roomId);
  broadcast();
  console.log(`➕ ${socketId.slice(0,6)} joined group ${g.code} (${g.members.length}/4)`);
  return true;
}

function broadcastGroupState(roomId) {
  const g = groups[roomId];
  if (!g) return;
  const needed = g.members.length === 3 ? 2 : 3;
  g.members.forEach(id => io.to(id).emit('group-state', {
    roomId,
    code      : g.code,
    members   : g.members,
    count     : g.members.length,
    open      : g.open,
    isPrivate : g.private,
    kickVotes : g.kickVotes ? {
      targetId : g.kickVotes.targetId,
      votes    : [...g.kickVotes.votes].length,
      needed
    } : null
  }));
}

function leaveGroup(socketId, roomId) {
  const g = groups[roomId];
  if (!g) return;

  g.members = g.members.filter(id => id !== socketId);
  delete socketRoom[socketId];

  if (g.kickVotes) {
    if (g.kickVotes.targetId === socketId || g.kickVotes.votes.has(socketId)) {
      g.kickVotes = null;
    }
  }

  if (g.members.length === 0) { delete groups[roomId]; return; }

  g.members.forEach(id => io.to(id).emit('member-left', {
    socketId, members: g.members
  }));

  // Reopen if was full
  if (g.members.length < 4 && !g.private) g.open = true;

  broadcastGroupState(roomId);
}

function cleanupSocket(socketId) {
  // Pair cleanup
  const partner = pairs[socketId];
  if (partner) {
    io.to(partner).emit('partner-disconnected');
    delete pairs[partner];
  }
  delete pairs[socketId];

  // Queue cleanup
  randomQueue = randomQueue.filter(id => id !== socketId);
  groupQueue  = groupQueue.filter(id => id !== socketId);

  // Group cleanup
  const roomId = socketRoom[socketId];
  if (roomId && groups[roomId]) leaveGroup(socketId, roomId);
  delete socketRoom[socketId];

  // Private waiting cleanup
  for (const code of Object.keys(privateWaiting)) {
    if (privateWaiting[code] === socketId) delete privateWaiting[code];
  }
}

// ════════════════════════════ SOCKET ════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id.slice(0,6)} connected`);
  broadcast();

  // ── JOIN RANDOM 1-to-1 QUEUE ──
  socket.on('join-queue', ({ vibe }) => {
    randomQueue = randomQueue.filter(id => id !== socket.id);
    groupQueue  = groupQueue.filter(id => id !== socket.id);

    if (randomQueue.length > 0) {
      const partnerId = randomQueue.shift();
      matchPair(socket.id, partnerId);
    } else {
      randomQueue.push(socket.id);
      socket.emit('waiting');
    }
    broadcast();
  });

  // ── JOIN RANDOM GROUP QUEUE ──
  socket.on('join-group-queue', () => {
    randomQueue = randomQueue.filter(id => id !== socket.id);
    groupQueue  = groupQueue.filter(id => id !== socket.id);

    // Find any open group
    const openRoom = Object.entries(groups).find(([id, g]) =>
      g.open && !g.private && g.members.length < 4
    );

    if (openRoom) {
      addToGroup(socket.id, openRoom[0]);
    } else {
      groupQueue.push(socket.id);
      socket.emit('waiting-group');
    }
    broadcast();
  });

  // ── WEBRTC SIGNALING ──
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

  // ── CHAT MESSAGE ──
  socket.on('chat-message', ({ text }) => {
    const roomId = socketRoom[socket.id];
    if (roomId && groups[roomId]) {
      groups[roomId].members
        .filter(id => id !== socket.id)
        .forEach(id => io.to(id).emit('chat-message', { text, from: socket.id }));
    } else {
      const p = pairs[socket.id];
      if (p) io.to(p).emit('chat-message', { text, from: socket.id });
    }
  });

  // ── TRUTH OR DARE ──
  socket.on('td-question', ({ type, question }) => {
    const roomId = socketRoom[socket.id];
    if (roomId && groups[roomId]) {
      groups[roomId].members
        .filter(id => id !== socket.id)
        .forEach(id => io.to(id).emit('td-question', { type, question }));
    } else {
      const p = pairs[socket.id];
      if (p) io.to(p).emit('td-question', { type, question });
    }
  });

  // ── OPEN GROUP (both agreed) ──
  // Either person in a pair can request to open as group
  socket.on('open-group-request', () => {
    const partner = pairs[socket.id];
    if (!partner) return;
    // Ask partner for consent
    io.to(partner).emit('open-group-ask', { from: socket.id });
    socket.emit('open-group-waiting');
  });

  socket.on('open-group-accept', () => {
    // Find the pair — either could be the one accepting
    const partner = pairs[socket.id];
    if (!partner) return;
    // Both agreed — convert to open group
    convertToGroup(socket.id, partner);
  });

  socket.on('open-group-decline', () => {
    const partner = pairs[socket.id];
    if (partner) io.to(partner).emit('open-group-declined');
  });

  // ── KICK VOTE ──
  socket.on('kick-vote', ({ targetId }) => {
    const roomId = socketRoom[socket.id];
    const g = groups[roomId];
    if (!g || !g.members.includes(targetId) || g.kickVotes) return;
    g.kickVotes = { targetId, votes: new Set([socket.id]) };
    const needed = g.members.length === 3 ? 2 : 3;
    g.members.forEach(id => io.to(id).emit('kick-vote-started', {
      targetId, by: socket.id, votes: 1, needed
    }));
    broadcastGroupState(roomId);
  });

  socket.on('kick-vote-cast', ({ roomId, agree }) => {
    const g = groups[roomId];
    if (!g || !g.kickVotes || !g.members.includes(socket.id)) return;
    if (socket.id === g.kickVotes.targetId) return;
    if (agree) g.kickVotes.votes.add(socket.id);
    const needed = g.members.length === 3 ? 2 : 3;
    const current = g.kickVotes.votes.size;
    g.members.forEach(id => io.to(id).emit('kick-vote-update', {
      targetId: g.kickVotes.targetId, votes: current, needed
    }));
    if (current >= needed) {
      const kickedId = g.kickVotes.targetId;
      g.kickVotes = null;
      io.to(kickedId).emit('you-were-kicked');
      leaveGroup(kickedId, roomId);
      delete socketRoom[kickedId];
      console.log(`🚫 Kicked ${kickedId.slice(0,6)} from ${g.code}`);
    }
    if (g.members && g.members.length > 0) broadcastGroupState(roomId);
    broadcast();
  });

  // ── PRIVATE ROOM ──
  socket.on('create-private-room', ({ code }) => {
    const key = code.toUpperCase();
    const roomId = 'prv_' + key;

    groups[roomId] = {
      members  : [socket.id],
      open     : false,
      private  : true,
      code     : key,
      kickVotes: null
    };

    socketRoom[socket.id] = roomId;

    // Tell creator — show code in chat
    socket.emit('private-room-created', { roomId, code: key });
    broadcast();
    console.log(`🔒 Private room ${key} created by ${socket.id.slice(0,6)}`);
  });

  socket.on('join-private-room', ({ code }) => {
    const key = code.toUpperCase();
    const roomId = 'prv_' + key;
    const g = groups[roomId];

    if (!g) { socket.emit('private-room-not-found'); return; }
    if (g.members.length >= 4) { socket.emit('private-room-full'); return; }

    addToGroup(socket.id, roomId);
    console.log(`🔒 ${socket.id.slice(0,6)} joined private room ${key}`);
  });

  // ── NEXT ──
  socket.on('next', () => {
    cleanupSocket(socket.id);
    if (randomQueue.length > 0) {
      matchPair(socket.id, randomQueue.shift());
    } else {
      randomQueue.push(socket.id);
      socket.emit('waiting');
    }
    broadcast();
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id.slice(0,6)} disconnected`);
    cleanupSocket(socket.id);
    broadcast();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════╗\n  ║  DARE.ME Server v3 Running 🎲     ║\n  ║  Port: ${PORT}                      ║\n  ╚═══════════════════════════════════╝\n`);
});
