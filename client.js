const socket = io('ivanish-lab-github-io.railway.internal');
let currentUser = null;
let currentRoom = null;
let currentStake = 100;
let gameState = null;
let selectedCardIndex = -1;
let roomsRefreshInterval = null;

// Переключение экранов
function showScreen(id) {
  if (id !== 'lobbyScreen' && roomsRefreshInterval) {
    clearInterval(roomsRefreshInterval);
    roomsRefreshInterval = null;
  }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  if (id === 'lobbyScreen') {
    refreshRooms();
    if (!roomsRefreshInterval) {
      roomsRefreshInterval = setInterval(() => refreshRooms(), 3000);
    }
  }
}

// Обновление баланса на экране
function updateBalanceDisplay(balance) {
  const el = document.getElementById('balanceDisplay');
  if (el) el.innerText = balance;
}

// Форматирование типа игры
function formatGameType(type) {
  return type === 'throw' ? 'Подкидной' : 'Переводной';
}

// Генерация кнопок выбора ставки
function generateStakeButtons() {
  const stakes = [100, 250, 500, 750, 1000, 1500, 2000];
  for (let i = 3000; i <= 10000; i += 1000) stakes.push(i);
  const container = document.getElementById('stakeButtons');
  container.innerHTML = '';
  stakes.forEach(s => {
    const btn = document.createElement('button');
    btn.textContent = s;
    btn.className = 'stake-btn' + (s === currentStake ? ' active' : '');
    btn.onclick = () => setStake(s);
    container.appendChild(btn);
  });
}

function setStake(value) {
  currentStake = value;
  document.getElementById('selectedStakeDisplay').innerText = value;
  document.querySelectorAll('.stake-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.textContent) === value);
  });
}

// Проверка авторизации
function ensureAuth() {
  if (!currentUser) {
    showScreen('loginScreen');
    return false;
  }
  return true;
}

// Создание DOM-элемента карты
function createCardElement(card) {
  const el = document.createElement('div');
  el.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : ''}`;
  el.textContent = card.rank + card.suit;
  return el;
}

// Сортировка карт
function sortHand(hand) {
  const suitOrder = { '♠': 1, '♥': 2, '♦': 3, '♣': 4 };
  const rankOrder = { '6':1,'7':2,'8':3,'9':4,'10':5,'J':6,'Q':7,'K':8,'A':9 };
  return [...hand].sort((a, b) => {
    if (a.suit !== b.suit) return suitOrder[a.suit] - suitOrder[b.suit];
    return rankOrder[a.rank] - rankOrder[b.rank];
  });
}

// Отрисовка игрового экрана
function renderGame() {
  if (!gameState) return;

  const handDiv = document.getElementById('playerHand');
  const tableDiv = document.getElementById('tableCards');
  const infoDiv = document.getElementById('gameInfo');
  const opponentDiv = document.getElementById('opponentInfo');

  if (!handDiv || !tableDiv || !infoDiv) return;

  handDiv.innerHTML = '';
  tableDiv.innerHTML = '';
  if (opponentDiv) opponentDiv.innerHTML = '';

  // Рука (сортированная)
  const myHand = sortHand(gameState.hand || []);
  myHand.forEach((card, i) => {
    const cardEl = createCardElement(card);
    cardEl.onclick = () => selectCard(i);
    handDiv.appendChild(cardEl);
  });

  // Стол (группировка по парам)
  gameState.table.forEach(pair => {
    const pairDiv = document.createElement('div');
    pairDiv.className = 'card-pair';
    pairDiv.appendChild(createCardElement(pair.attack));
    if (pair.defense) {
      pairDiv.appendChild(createCardElement(pair.defense));
    }
    tableDiv.appendChild(pairDiv);
  });

  // Информация о сопернике
  if (opponentDiv) {
    const opponent = gameState.players?.find(p => p.username !== currentUser);
    if (opponent) {
      opponentDiv.innerHTML = `Соперник: ${opponent.username} | Карт: ${opponent.cardCount}`;
    }
  }

  const attackerText = (gameState.attacker === currentUser) ? 'Атакуете вы' : `Атакует ${gameState.attacker}`;
  const defenderText = (gameState.defender === currentUser) ? 'Защищаетесь вы' : `Защищается ${gameState.defender}`;
  const readyToFinish = gameState.readyToFinish || [];
  const iAmReady = readyToFinish.includes(currentUser);

  infoDiv.innerHTML = `
    Козырь: ${gameState.trumpSuit} (${gameState.trumpCard.rank}${gameState.trumpCard.suit})<br>
    В колоде: ${gameState.deckCount}<br>
    ${attackerText} | ${defenderText}<br>
    Фаза: ${gameState.turnPhase === 'attack' ? 'Атака' : 'Защита'}<br>
    ${readyToFinish.length > 0 ? `Готовы завершить: ${readyToFinish.join(', ')}` : ''}
  `;

  const controls = document.getElementById('gameControls');
  if (!controls) return;
  controls.innerHTML = '';

  if (gameState.winner) {
    controls.innerHTML = `<button onclick="leaveRoom()">Выйти</button>`;
    return;
  }

  // Кнопка "Завершить раунд"
  controls.innerHTML += `<button onclick="finishRound()" ${iAmReady ? 'disabled' : ''}>${iAmReady ? 'Ожидание соперника...' : 'Завершить раунд'}</button>`;

  const isMyTurn = (gameState.turnPhase === 'attack' && currentUser === gameState.attacker) ||
                   (gameState.turnPhase === 'defend' && currentUser === gameState.defender);

  if (!isMyTurn) {
    controls.innerHTML += '<p>Ожидайте хода соперника...</p>';
    return;
  }

  if (currentUser === gameState.attacker && gameState.turnPhase === 'attack') {
    controls.innerHTML += `<button onclick="attack()">Атаковать выбранной</button>`;
    const allDefended = gameState.table.length > 0 && gameState.table.every(p => p.defense);
    if (allDefended) {
      controls.innerHTML += `<button onclick="beat()">Бито</button>`;
    }
  }

  if (currentUser === gameState.defender && gameState.turnPhase === 'defend') {
    controls.innerHTML += `<button onclick="defend()">Отбиться выбранной</button>`;
    controls.innerHTML += `<button onclick="takeCards()">Забрать</button>`;
    if (gameState.gameType === 'transfer') {
      controls.innerHTML += `<button onclick="transfer()">Перевести</button>`;
    }
  }
}

function selectCard(index) {
  selectedCardIndex = index;
  document.querySelectorAll('#playerHand .card').forEach((c, i) => {
    c.classList.toggle('selected', i === index);
  });
}

function attack() {
  if (selectedCardIndex === -1) { alert('Выберите карту'); return; }
  const card = gameState.hand[selectedCardIndex];
  socket.emit('gameAction', 'attack', { card }, res => {
    if (res?.error) alert(res.error);
    selectedCardIndex = -1;
  });
}

function defend() {
  if (selectedCardIndex === -1) { alert('Выберите карту'); return; }
  const defendCard = gameState.hand[selectedCardIndex];
  const attackPair = gameState.table.find(p => !p.defense);
  if (!attackPair) { alert('Нет карт для отбивания'); return; }
  socket.emit('gameAction', 'defend', { attackCard: attackPair.attack, defendCard }, res => {
    if (res?.error) alert(res.error);
    selectedCardIndex = -1;
  });
}

function beat() {
  socket.emit('gameAction', 'beat', {}, res => {
    if (res?.error) alert(res.error);
  });
}

function takeCards() {
  socket.emit('gameAction', 'take', {}, res => {
    if (res?.error) alert(res.error);
  });
}

function transfer() {
  if (selectedCardIndex === -1) { alert('Выберите карту того же достоинства'); return; }
  const card = gameState.hand[selectedCardIndex];
  socket.emit('gameAction', 'transfer', { card }, res => {
    if (res?.error) alert(res.error);
    selectedCardIndex = -1;
  });
}

function finishRound() {
  socket.emit('gameAction', 'finishRound', {}, res => {
    if (res?.error) alert(res.error);
  });
}

// Сетевые события
socket.on('balanceUpdated', data => {
  updateBalanceDisplay(data.balance);
  alert(`💰 Баланс изменён: ${data.balance}`);
});

socket.on('roomUpdate', room => {
  document.getElementById('playersList').innerText = room.players.join(', ');
  document.getElementById('roomStake').innerText = room.stake;
  document.getElementById('roomGameType').innerText = formatGameType(room.gameType);
  document.getElementById('startGameBtn').disabled = (room.host !== currentUser || room.players.length < 2);
});

socket.on('roomsList', rooms => {
  const container = document.getElementById('roomsList');
  if (!container) return;
  container.innerHTML = rooms.length ? '' : '<div>Нет активных комнат</div>';
  rooms.forEach(room => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `<span>${room.id} | Ставка: ${room.stake}💰 | ${formatGameType(room.gameType)} | Игроков: ${room.players}/2</span>
      <button onclick="joinRoomById('${room.id}')">Войти</button>`;
    container.appendChild(div);
  });
});

socket.on('gameState', state => {
  console.log('Получено состояние игры:', state);
  // Сбрасываем выбранную карту при обновлении состояния
  selectedCardIndex = -1;
  // Сортируем руку (если нужно)
  if (state.hand) {
    state.hand = sortHand(state.hand);
  }
  gameState = state;
  showScreen('gameScreen');
  renderGame();
});

socket.on('playerWantsFinish', username => {
  alert(`${username} хочет завершить раунд`);
});

socket.on('roundFinished', data => {
  alert(data.message);
  leaveRoom();
});

socket.on('gameOver', data => {
  alert(data.message);
  leaveRoom();
});

socket.on('playerLeft', username => {
  alert(`${username} покинул комнату`);
  if (currentRoom) leaveRoom();
});

socket.on('disconnect', () => {
  if (currentUser) { alert('Соединение потеряно'); currentUser = null; }
  showScreen('loginScreen');
});

// Действия
function login() {
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!username || !password) return;
  socket.emit('register', { username, password }, res => {
    if (res.error) document.getElementById('loginError').innerText = res.error;
    else {
      currentUser = username;
      updateBalanceDisplay(res.balance);
      showScreen('lobbyScreen');
      generateStakeButtons();
      refreshRooms();
    }
  });
}

function createRoom() {
  if (!ensureAuth()) return;
  const gameType = document.getElementById('gameTypeSelect').value;
  socket.emit('createRoom', { stake: currentStake, gameType }, res => {
    if (res.error) alert(res.error);
    else { currentRoom = res.roomId; document.getElementById('roomIdDisplay').innerText = currentRoom; showScreen('roomScreen'); }
  });
}

function joinRoom() { joinRoomById(document.getElementById('roomIdInput').value.trim().toUpperCase()); }
function joinRoomById(roomId) {
  if (!ensureAuth()) return;
  socket.emit('joinRoom', roomId, res => {
    if (res.error) {
      alert(res.error);
      if (res.error === 'Комната не найдена') refreshRooms();
    } else {
      currentRoom = roomId;
      document.getElementById('roomIdDisplay').innerText = currentRoom;
      showScreen('roomScreen');
    }
  });
}

function startGame() { socket.emit('startGame', res => { if (res?.error) alert(res.error); }); }
function leaveRoom() { socket.emit('leaveRoom', () => { currentRoom = null; showScreen('lobbyScreen'); refreshRooms(); }); }
function refreshRooms() { socket.emit('getRooms', () => {}); }

window.addEventListener('load', () => showScreen('loginScreen'));
