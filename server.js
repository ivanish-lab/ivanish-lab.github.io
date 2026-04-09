const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Замените 'your-username' на ваше имя пользователя GitHub
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://ivanish-lab.github.io"],
    methods: ["GET", "POST"]
  }
});
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================== КОНФИГУРАЦИЯ ==================
const START_BALANCE = 1000;
const DATA_FILE = path.join(__dirname, 'players.json');
const ADMIN_FILE = path.join(__dirname, 'admin.json');
const MAX_ATTACK_CARDS = 6;
const COMMISSION_RATE = 0.1; // 10% комиссия
// ================== ХЭШИРОВАНИЕ ==================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// ================== ЗАГРУЗКА / СОХРАНЕНИЕ ИГРОКОВ ==================
let players = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    players = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Ошибка чтения players.json:', e);
  }
}

function savePlayers() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(players, null, 2));
}

// ================== ЗАГРУЗКА / СОХРАНЕНИЕ АДМИНА ==================
let adminConfig = {
  login: 'admin',
  passwordHash: hashPassword('admin123'),
  failedAttempts: {},
  sessions: {}
};

if (fs.existsSync(ADMIN_FILE)) {
  try {
    adminConfig = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  } catch (e) {
    console.error('Ошибка чтения admin.json');
  }
} else {
  saveAdminConfig();
}

function saveAdminConfig() {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminConfig, null, 2));
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let ip in adminConfig.failedAttempts) {
    if (now - adminConfig.failedAttempts[ip].timestamp > 3600000) {
      delete adminConfig.failedAttempts[ip];
      changed = true;
    }
  }
  for (let token in adminConfig.sessions) {
    if (now - adminConfig.sessions[token].createdAt > 86400000) {
      delete adminConfig.sessions[token];
      changed = true;
    }
  }
  if (changed) saveAdminConfig();
}, 3600000);

// ================== ХРАНИЛИЩЕ КОМНАТ (в памяти) ==================
const rooms = {};

// ================== ИГРОВЫЕ КОНСТАНТЫ И ФУНКЦИИ ==================
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['8', '9', '10', 'J'];
//const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (let suit of SUITS) {
    for (let rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return shuffle(deck);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function compareCards(card1, card2, trumpSuit) {
  const rankIndex1 = RANKS.indexOf(card1.rank);
  const rankIndex2 = RANKS.indexOf(card2.rank);
  if (card1.suit === trumpSuit && card2.suit !== trumpSuit) return 1;
  if (card2.suit === trumpSuit && card1.suit !== trumpSuit) return -1;
  if (card1.suit === card2.suit) {
    return rankIndex1 - rankIndex2;
  }
  return 0;
}

// ================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==================
function getRoomList() {
  return Object.values(rooms)
    .filter(r => !r.gameState || !r.gameState.started)
    .filter(r => r.players.length < 2)
    .map(r => ({
      id: r.id,
      stake: r.stake,
      gameType: r.gameType,
      players: r.players.length,
      host: r.host,
      createdAt: r.createdAt
    }));
}

function sendGameStateToPlayer(room, player) {
  const gs = room.gameState;
  if (!gs) return;
  const playerData = players[player];
  if (!playerData) return;
  const playerSocketId = playerData.socketId;
  if (!playerSocketId) return;
  const stateForPlayer = {
    started: gs.started,
    gameType: gs.gameType,
    trumpSuit: gs.trumpSuit,
    trumpCard: gs.trumpCard,
    deckCount: gs.deck.length,
    hand: gs.hands[player] || [],
    table: gs.table,
    attacker: gs.attacker,
    defender: gs.defender,
    turnPhase: gs.turnPhase,
    winner: gs.winner,
    players: room.players.map(p => ({
      username: p,
      cardCount: gs.hands[p]?.length || 0
    })),
    readyToFinish: gs.readyToFinish || []
  };
  io.to(playerSocketId).emit('gameState', stateForPlayer);
}

function sendGameState(room) {
  room.players.forEach(player => sendGameStateToPlayer(room, player));
}
function checkGameOver(room) {
  const gs = room.gameState;
  if (!gs) return false;
  const alivePlayers = room.players.filter(p => gs.hands[p] && gs.hands[p].length > 0);
  if (alivePlayers.length <= 1 && gs.deck.length === 0) {
    const winner = alivePlayers[0] || null;
    gs.winner = winner;
    gs.started = false;
    if (winner) {
      const totalStake = room.stake * 2;
      const commission = Math.floor(totalStake * COMMISSION_RATE);
      const winAmount = totalStake - commission;
      players[winner].balance += winAmount;
      savePlayers();
      const socketId = players[winner].socketId;
      if (socketId) {
        io.to(socketId).emit('balanceUpdated', { balance: players[winner].balance });
      }
    }
    io.to(room.id).emit('gameOver', { 
      winner, 
      message: winner ? `${winner} победил и получает ${Math.floor(room.stake * 2 * (1 - COMMISSION_RATE))}💰 (комиссия ${Math.floor(room.stake * 2 * COMMISSION_RATE)}💰)` : 'Ничья' 
    });
    sendGameState(room);
    setTimeout(() => {
      delete rooms[room.id];
      io.emit('roomsList', getRoomList());
    }, 5000);
    return true;
  }
  return false;
}

// ================== API ЭНДПОИНТЫ ==================
app.get('/api/rooms', (req, res) => res.json(getRoomList()));

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const attempt = adminConfig.failedAttempts[ip];
  if (attempt && attempt.count >= 5 && Date.now() - attempt.timestamp < 900000) {
    return res.status(403).json({ error: 'Слишком много попыток. Попробуйте позже.' });
  }
  if (login !== adminConfig.login || hashPassword(password) !== adminConfig.passwordHash) {
    if (!adminConfig.failedAttempts[ip]) adminConfig.failedAttempts[ip] = { count: 1, timestamp: Date.now() };
    else { adminConfig.failedAttempts[ip].count++; adminConfig.failedAttempts[ip].timestamp = Date.now(); }
    saveAdminConfig();
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  delete adminConfig.failedAttempts[ip];
  const sessionToken = crypto.randomBytes(32).toString('hex');
  adminConfig.sessions[sessionToken] = { createdAt: Date.now(), ip };
  saveAdminConfig();
  res.json({ success: true, token: sessionToken });
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminConfig.sessions[token]) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || req.body.token;
  if (token && adminConfig.sessions[token]) { delete adminConfig.sessions[token]; saveAdminConfig(); }
  res.json({ success: true });
});

app.get('/api/admin/players', requireAdmin, (req, res) => {
  res.json(Object.values(players).map(p => ({ username: p.username, balance: p.balance })));
});

app.post('/api/admin/balance', requireAdmin, (req, res) => {
  const { username, amount } = req.body;
  if (!players[username]) return res.status(404).json({ error: 'Игрок не найден' });
  players[username].balance += amount;
  savePlayers();
  const player = players[username];
  if (player.socketId) io.to(player.socketId).emit('balanceUpdated', { balance: player.balance });
  res.json({ success: true, newBalance: player.balance });
});

// ================== WEBSOCKET ==================
io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  socket.on('register', (data, callback) => {
    const { username, password } = data;
    if (!username || username.length < 3) return callback({ error: 'Имя должно быть не менее 3 символов' });
    if (!password || password.length < 4) return callback({ error: 'Пароль должен быть не менее 4 символов' });
    const passwordHash = hashPassword(password);
    if (players[username]) {
      if (players[username].passwordHash !== passwordHash) return callback({ error: 'Неверный пароль' });
    } else {
      players[username] = { username, passwordHash, balance: START_BALANCE, createdAt: new Date().toISOString() };
      savePlayers();
    }
    players[username].socketId = socket.id;
    socket.username = username;
    callback({ success: true, balance: players[username].balance });
    socket.emit('roomsList', getRoomList());
  });

  socket.on('createRoom', (data, callback) => {
    const username = socket.username;
    if (!username) return callback({ error: 'Не авторизован' });
    const { stake, gameType } = data;
    if (typeof stake !== 'number' || stake <= 0) return callback({ error: 'Некорректная ставка' });
    if (!['throw', 'transfer'].includes(gameType)) return callback({ error: 'Неверный тип игры' });
    if (players[username].balance < stake) return callback({ error: 'Недостаточно средств' });

    players[username].balance -= stake;
    savePlayers();
    if (players[username].socketId) io.to(players[username].socketId).emit('balanceUpdated', { balance: players[username].balance });

    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      players: [username],
      host: username,
      stake,
      gameType,
      gameState: null,
      createdAt: Date.now()
    };
    players[username].roomId = roomId;
    socket.join(roomId);
    callback({ roomId });
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
    io.emit('roomsList', getRoomList());
  });

  socket.on('joinRoom', (roomId, callback) => {
    const username = socket.username;
    if (!username) return callback({ error: 'Не авторизован' });
    const room = rooms[roomId];
    if (!room) return callback({ error: 'Комната не найдена' });
    if (room.players.length >= 2) return callback({ error: 'Комната заполнена' });
    if (room.gameState) return callback({ error: 'Игра уже идёт' });
    if (players[username].balance < room.stake) return callback({ error: 'Недостаточно средств' });

    players[username].balance -= room.stake;
    savePlayers();
    if (players[username].socketId) io.to(players[username].socketId).emit('balanceUpdated', { balance: players[username].balance });

    room.players.push(username);
    players[username].roomId = roomId;
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('roomUpdate', room);
    io.emit('roomsList', getRoomList());
  });

  socket.on('getRooms', (callback) => callback(getRoomList()));

  socket.on('startGame', (callback) => {
    const username = socket.username;
    if (!username) return callback({ error: 'Не авторизован' });
    const room = rooms[players[username]?.roomId];
    if (!room) return callback({ error: 'Вы не в комнате' });
    if (room.host !== username) return callback({ error: 'Только хозяин может начать игру' });
    if (room.players.length < 2) return callback({ error: 'Недостаточно игроков' });
    if (room.gameState) return callback({ error: 'Игра уже идёт' });

    const deck = createDeck();
    const hands = {};
    room.players.forEach(p => { hands[p] = deck.splice(0, 6); });

    const trumpCard = deck[deck.length - 1];
    const trumpSuit = trumpCard.suit;

    const attackerIndex = Math.floor(Math.random() * 2);
    room.gameState = {
      started: true,
      deck,
      trumpSuit,
      trumpCard,
      hands,
      table: [],
      attacker: room.players[attackerIndex],
      defender: room.players[1 - attackerIndex],
      turnPhase: 'attack',
      passCount: 0,
      winner: null,
      gameType: room.gameType,
      readyToFinish: []
    };
    console.log(`Игра началась в комнате ${room.id}`);
    sendGameState(room);
    io.emit('roomsList', getRoomList());
    callback({ success: true });
  });

  socket.on('gameAction', (action, data, callback) => {
    const username = socket.username;
    const room = rooms[players[username]?.roomId];
    if (!room || !room.gameState) return callback?.({ error: 'Игра не найдена' });
    const gs = room.gameState;
    const player = username;

    if (action === 'finishRound') {
      if (!gs.readyToFinish) gs.readyToFinish = [];
      if (!gs.readyToFinish.includes(player)) {
        gs.readyToFinish.push(player);
      }
      io.to(room.id).emit('playerWantsFinish', player);
      
      if (gs.readyToFinish.length >= 2) {
        room.players.forEach(p => {
          players[p].balance += 90;
          savePlayers();
          const sockId = players[p].socketId;
          if (sockId) io.to(sockId).emit('balanceUpdated', { balance: players[p].balance });
        });
        io.to(room.id).emit('roundFinished', { message: 'Раунд завершён по согласию. Ставки возвращены.' });
        room.gameState = null;
        io.to(room.id).emit('roomUpdate', room);
        io.emit('roomsList', getRoomList());
        sendGameState(room);
        return callback?.({ success: true });
      }
      sendGameState(room);
      return callback?.({ success: true });
    }

    if (gs.turnPhase === 'attack' && player !== gs.attacker) return callback?.({ error: 'Сейчас не ваша очередь атаковать' });
    if (gs.turnPhase === 'defend' && player !== gs.defender) return callback?.({ error: 'Сейчас не ваша очередь защищаться' });

    if (action === 'attack') {
      const card = data.card;
      const hand = gs.hands[player];
      const cardIndex = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
      if (cardIndex === -1) return callback?.({ error: 'У вас нет такой карты' });

      const currentAttackCount = gs.table.filter(p => !p.defense).length;
      if (currentAttackCount >= MAX_ATTACK_CARDS) {
        return callback?.({ error: 'Нельзя подкинуть больше 6 карт' });
      }
      const defenderHandSize = gs.hands[gs.defender]?.length || 0;
      if (currentAttackCount >= defenderHandSize) {
        return callback?.({ error: 'У защищающегося не хватит карт для отбития' });
      }

      if (gs.table.length === 0 || gs.turnPhase === 'attack') {
        if (gs.table.length > 0) {
          const allowedRanks = gs.table.flatMap(pair => [pair.attack.rank, pair.defense?.rank].filter(Boolean));
          if (!allowedRanks.includes(card.rank)) return callback?.({ error: 'Нельзя подкинуть карту этого достоинства' });
        }
        hand.splice(cardIndex, 1);
        gs.table.push({ attack: card, defense: null });
        gs.turnPhase = 'defend';
        gs.passCount = 0;
        sendGameState(room);
        callback?.({ success: true });
      } else {
        callback?.({ error: 'Сейчас нельзя атаковать' });
      }
    } else if (action === 'defend') {
      const { attackCard, defendCard } = data;
      const hand = gs.hands[player];
      const pair = gs.table.find(p => p.attack.suit === attackCard.suit && p.attack.rank === attackCard.rank && !p.defense);
      if (!pair) return callback?.({ error: 'Такая атакующая карта не найдена' });
      const cardIndex = hand.findIndex(c => c.suit === defendCard.suit && c.rank === defendCard.rank);
      if (cardIndex === -1) return callback?.({ error: 'У вас нет такой карты' });
      if (compareCards(defendCard, pair.attack, gs.trumpSuit) <= 0) return callback?.({ error: 'Карта не бьёт атакующую' });

      hand.splice(cardIndex, 1);
      pair.defense = defendCard;
      
      const allDefended = gs.table.every(p => p.defense);
      if (allDefended) {
        gs.turnPhase = 'attack';
        gs.readyToFinish = [];
      } else {
        gs.turnPhase = 'defend';
      }
      sendGameState(room);
      callback?.({ success: true });
    } else if (action === 'beat') {
      if (gs.turnPhase !== 'attack' || player !== gs.attacker) return callback?.({ error: 'Сейчас нельзя бить' });
      if (gs.table.length === 0) return callback?.({ error: 'Нечего бить' });
      const allDefended = gs.table.every(p => p.defense);
      if (!allDefended) return callback?.({ error: 'Не все карты отбиты' });
      
      gs.table = [];
      room.players.forEach(p => {
        while (gs.hands[p].length < 6 && gs.deck.length > 0) {
          gs.hands[p].push(gs.deck.pop());
        }
      });
      [gs.attacker, gs.defender] = [gs.defender, gs.attacker];
      gs.turnPhase = 'attack';
      gs.passCount = 0;
      gs.readyToFinish = [];
      if (checkGameOver(room)) return;
      sendGameState(room);
      callback?.({ success: true });
    } else if (action === 'take') {
      if (gs.table.length === 0) return callback?.({ error: 'Нечего брать' });
      const cardsToTake = gs.table.flatMap(p => [p.attack, p.defense]).filter(c => c);
      gs.hands[player].push(...cardsToTake);
      gs.table = [];
      
      room.players.forEach(p => {
        while (gs.hands[p].length < 6 && gs.deck.length > 0) {
          gs.hands[p].push(gs.deck.pop());
        }
      });
      
      gs.turnPhase = 'attack';
      gs.passCount = 0;
      gs.readyToFinish = [];
      if (checkGameOver(room)) return;
      sendGameState(room);
      callback?.({ success: true });
    } else if (action === 'transfer') {
      if (gs.gameType !== 'transfer') return callback?.({ error: 'Перевод доступен только в переводном дураке' });
      if (gs.turnPhase !== 'defend' || player !== gs.defender) return callback?.({ error: 'Только защищающийся может перевести' });
      if (gs.table.length === 0) return callback?.({ error: 'Нет атакующих карт для перевода' });
      
      const card = data.card;
      const hand = gs.hands[player];
      const cardIndex = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
      if (cardIndex === -1) return callback?.({ error: 'У вас нет такой карты' });

      const targetPair = gs.table.find(p => !p.defense);
      if (!targetPair) return callback?.({ error: 'Нет неотбитой карты для перевода' });
      if (targetPair.attack.rank !== card.rank) return callback?.({ error: 'Для перевода нужна карта того же достоинства' });

      const currentAttackCount = gs.table.filter(p => !p.defense).length;
      if (currentAttackCount >= MAX_ATTACK_CARDS) return callback?.({ error: 'Нельзя подкинуть больше 6 карт' });
      const defenderHandSize = gs.hands[gs.defender]?.length || 0;
      if (currentAttackCount >= defenderHandSize) return callback?.({ error: 'У защищающегося не хватит карт' });

      hand.splice(cardIndex, 1);
      gs.table.push({ attack: card, defense: null });
      
      [gs.attacker, gs.defender] = [gs.defender, gs.attacker];
      gs.turnPhase = 'defend';
      gs.passCount = 0;
      
      sendGameState(room);
      callback?.({ success: true });
    } else {
      callback?.({ error: 'Неизвестное действие' });
    }
  });

  socket.on('leaveRoom', (callback) => {
    const username = socket.username;
    if (!username) return callback?.({ error: 'Не авторизован' });
    const roomId = players[username]?.roomId;
    if (!roomId || !rooms[roomId]) return callback?.({ error: 'Вы не в комнате' });
    const room = rooms[roomId];
    if (!room.gameState) {
      players[username].balance += room.stake;
      savePlayers();
      if (players[username].socketId) io.to(players[username].socketId).emit('balanceUpdated', { balance: players[username].balance });
    }
    room.players = room.players.filter(p => p !== username);
    socket.leave(roomId);
    delete players[username].roomId;
    if (room.players.length === 0) delete rooms[roomId];
    else io.to(roomId).emit('roomUpdate', room);
    io.emit('roomsList', getRoomList());
    callback?.({ success: true });
  });

  socket.on('disconnect', () => {
    const username = socket.username;
    if (username && players[username]) {
      delete players[username].socketId;
      const roomId = players[username].roomId;
      if (roomId && rooms[roomId]) {
        const room = rooms[roomId];
        if (!room.gameState) {
          players[username].balance += room.stake;
          savePlayers();
        }
        io.to(roomId).emit('playerLeft', username);
        room.players = room.players.filter(p => p !== username);
        if (room.players.length === 0) delete rooms[roomId];
        else io.to(roomId).emit('roomUpdate', room);
        io.emit('roomsList', getRoomList());
      }
      delete players[username].roomId;
      savePlayers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));
