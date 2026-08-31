const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const WORDS = [
  'apple','banana','guitar','elephant','castle','rainbow','pizza','robot','dragon',
  'umbrella','bicycle','volcano','penguin','sandwich','rocket','octopus','cactus',
  'mountain','waterfall','skateboard','telescope','lighthouse','pumpkin','snowman',
  'butterfly','helicopter','campfire','waffle','tornado','pirate','mermaid','wizard',
  'jellyfish','kangaroo','lantern','microphone','notebook','pancake','quicksand',
  'raccoon','saxophone','treasure','unicorn','volleyball','windmill','xylophone',
  'yoyo','zebra','anchor','balloon','cupcake','dolphin','earthquake','flamingo',
  'giraffe','hammock','igloo','jackpot','kite','ladder','mailbox','necklace',
  'ostrich','parachute','quilt','rainforest','scarecrow','tractor','vampire',
  'wheelbarrow','yacht','avalanche','beehive','crown','dinosaur','eyeglasses',
  'fireworks','glacier','hedgehog','iceberg','jukebox','koala','lava','moon',
  'nest','oasis','peacock','quiver','saddle','turtle','vulture','compass','chimney','parrot','sword','castle','spaceship','windshield','geyser',
  'crocodile','hourglass','binoculars','mushroom','bridge','skeleton','seashell'
];

const rooms = {};
const ROUND_SECONDS = 80;
const ROUNDS_PER_PLAYER = 3;
const CHOOSE_TIME_MS = 12000;
const BETWEEN_ROUND_MS = 4000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function pickWords(n = 3) {
  const pool = [...WORDS];
  const picked = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function getBlanks(word) {
  return word.split('').map(ch => (ch === ' ' ? ' ' : '_')).join(' ');
}

function nameOf(room, id) {
  const p = room.players.find(p => p.id === id);
  return p ? p.name : '???';
}

function publicPlayers(room) {
  return room.players
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      isDrawer: p.id === room.drawerId,
      guessed: room.guessedIds.includes(p.id)
    }))
    .sort((a, b) => b.score - a.score);
}

function roomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    players: publicPlayers(room)
  };
}

function tick(room) {
  room.timeLeft--;
  io.to(room.code).emit('timer', room.timeLeft);
  if (room.timeLeft <= 0) endRound(room);
}

function endRound(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  if (room.state === 'drawing') {
    io.to(room.code).emit('round-end', { word: room.word || '' });
  }
  room.state = 'between';
  io.to(room.code).emit('score-update', publicPlayers(room));
  setTimeout(() => startNextTurn(room), BETWEEN_ROUND_MS);
}

function startNextTurn(room) {
  if (!rooms[room.code]) return;
  if (room.players.length < 2) {
    room.state = 'lobby';
    io.to(room.code).emit('room-update', roomSummary(room));
    return;
  }
  room.round++;
  if (room.round > room.totalRounds) {
    room.state = 'ended';
    io.to(room.code).emit('game-over', publicPlayers(room));
    return;
  }
  room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  room.drawerId = room.players[room.drawerIndex].id;
  room.state = 'choosing';
  room.word = null;
  room.guessedIds = [];
  const options = pickWords(3);
  room.pendingOptions = options;

  io.to(room.code).emit('turn-starting', {
    drawerId: room.drawerId,
    drawerName: nameOf(room, room.drawerId),
    round: room.round,
    totalRounds: room.totalRounds
  });
  io.to(room.drawerId).emit('choose-word-options', options);

  room.chooseTimeout = setTimeout(() => {
    if (room.state === 'choosing') {
      const forced = options[Math.floor(Math.random() * options.length)];
      beginDrawing(room, forced);
    }
  }, CHOOSE_TIME_MS);
}

function beginDrawing(room, word) {
  if (room.chooseTimeout) { clearTimeout(room.chooseTimeout); room.chooseTimeout = null; }
  room.word = word;
  room.state = 'drawing';
  room.guessedIds = [];
  room.timeLeft = ROUND_SECONDS;

  const drawerSocket = io.sockets.sockets.get(room.drawerId);
  if (drawerSocket) drawerSocket.emit('your-word', word);

  io.to(room.code).emit('round-start', {
    drawerId: room.drawerId,
    drawerName: nameOf(room, room.drawerId),
    blanks: getBlanks(word),
    timeLeft: room.timeLeft,
    round: room.round,
    totalRounds: room.totalRounds
  });

  room.timer = setInterval(() => tick(room), 1000);
}

io.on('connection', socket => {
  socket.on('create-room', ({ name }) => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      players: [{ id: socket.id, name: (name || 'Player').slice(0, 16), score: 0 }],
      hostId: socket.id,
      state: 'lobby',
      drawerIndex: -1,
      drawerId: null,
      word: null,
      guessedIds: [],
      round: 0,
      totalRounds: 0,
      timer: null,
      chooseTimeout: null,
      timeLeft: 0
    };
    socket.join(code);
    socket.data.room = code;
    socket.emit('room-created', { code });
    io.to(code).emit('room-update', roomSummary(rooms[code]));
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('error-msg', "That room code doesn't exist."); return; }
    if (room.state !== 'lobby') { socket.emit('error-msg', 'That game already started.'); return; }
    room.players.push({ id: socket.id, name: (name || 'Player').slice(0, 16), score: 0 });
    socket.join(code);
    socket.data.room = code;
    socket.emit('room-joined', { code });
    io.to(code).emit('room-update', roomSummary(room));
  });

  socket.on('start-game', () => {
    const room = rooms[socket.data.room];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error-msg', 'You need at least 2 players.'); return; }
    room.totalRounds = room.players.length * ROUNDS_PER_PLAYER;
    room.round = 0;
    room.drawerIndex = -1;
    startNextTurn(room);
  });

  socket.on('choose-word', word => {
    const room = rooms[socket.data.room];
    if (!room || room.drawerId !== socket.id || room.state !== 'choosing') return;
    if (!room.pendingOptions || !room.pendingOptions.includes(word)) return;
    beginDrawing(room, word);
  });

  socket.on('draw', data => {
    const room = rooms[socket.data.room];
    if (!room || room.drawerId !== socket.id) return;
    socket.to(room.code).emit('draw', data);
  });

  socket.on('clear-canvas', () => {
    const room = rooms[socket.data.room];
    if (!room || room.drawerId !== socket.id) return;
    io.to(room.code).emit('clear-canvas');
  });

  socket.on('guess', text => {
    const room = rooms[socket.data.room];
    if (!room || room.state !== 'drawing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = String(text || '').trim().slice(0, 80);
    if (!clean) return;

    if (socket.id === room.drawerId || room.guessedIds.includes(socket.id)) {
      io.to(room.code).emit('chat-message', { name: player.name, text: clean, self: false });
      return;
    }

    if (clean.toLowerCase() === (room.word || '').toLowerCase()) {
      room.guessedIds.push(socket.id);
      const bonus = Math.max(20, Math.round(100 * (room.timeLeft / ROUND_SECONDS)));
      player.score += bonus;
      const drawer = room.players.find(p => p.id === room.drawerId);
      if (drawer) drawer.score += 15;
      io.to(room.code).emit('system-message', `${player.name} guessed the word!`);
      io.to(room.code).emit('score-update', publicPlayers(room));
      socket.emit('guess-correct', room.word);

      const guessersNeeded = room.players.filter(p => p.id !== room.drawerId).length;
      if (room.guessedIds.length >= guessersNeeded) endRound(room);
    } else {
      io.to(room.code).emit('chat-message', { name: player.name, text: clean });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const wasDrawer = room.drawerId === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      if (room.timer) clearInterval(room.timer);
      if (room.chooseTimeout) clearTimeout(room.chooseTimeout);
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    io.to(code).emit('room-update', roomSummary(room));

    if (wasDrawer && (room.state === 'drawing' || room.state === 'choosing')) {
      endRound(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Squiggle running on port ${PORT}`));