/**
 * src/main.js — Tebak Gambar
 *
 * Fase 1b: canvas gambar lokal, 100% client-side.
 * Fase 1c: guess box lokal — tebak kata hardcoded, belum multiplayer.
 * Fase 2a: Supabase Realtime room — lobby, join/create, status koneksi.
 * Fase 2b: broadcast 'chat' — uji dua-arah sebelum stroke gambar.
 * Fase 2c: broadcast stroke real-time dengan batching ~60ms.
 * Native Canvas API, tanpa library eksternal.
 */

import {
  generateRoomCode,
  joinRoom,
  leaveRoom,
  sendChat,
  sendStroke,
  sendClear,
  onStatusChange,
  onMemberChange,
  onChatMessage,
  onStroke,
  onClear,
} from './room.js';

/* ============================================================
 * Screen switching
 * ============================================================ */

const lobbyScreen = /** @type {HTMLElement} */ (document.getElementById('lobbyScreen'));
const gameScreen  = /** @type {HTMLElement} */ (document.getElementById('gameScreen'));

/**
 * showGame - Hide lobby, reveal game screen, then initialise canvas.
 */
function showGame() {
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  /* ensure DOM layout has rendered before sizing canvas */
  requestAnimationFrame(() => {
    resize();
  });
}

/** showLobby - Return to lobby, leave the current room. */
async function showLobby() {
  await leaveRoom();
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  joinCodeInput.value = '';
  joinErrorEl.textContent = '';
}

/* ============================================================
 * Room bar & Role DOM refs
 * ============================================================ */
const roomCodeDisplay   = /** @type {HTMLElement}      */ (document.getElementById('roomCodeDisplay'));
const roomMembersEl     = /** @type {HTMLElement}      */ (document.getElementById('roomMembers'));
const connBadgeEl       = /** @type {HTMLElement}      */ (document.getElementById('connBadge'));
const btnLeaveRoom      = /** @type {HTMLButtonElement} */ (document.getElementById('btnLeaveRoom'));
const btnRoleToggle     = /** @type {HTMLButtonElement} */ (document.getElementById('btnRoleToggle'));
const drawingIndicator  = /** @type {HTMLElement}       */ (document.getElementById('drawingIndicator'));
const canvasWrapper     = /** @type {HTMLElement}       */ (document.getElementById('canvasWrapper'));

/* ============================================================
 * Lobby DOM refs
 * ============================================================ */
const btnCreateRoom  = /** @type {HTMLButtonElement} */ (document.getElementById('btnCreateRoom'));
const btnJoinRoom    = /** @type {HTMLButtonElement} */ (document.getElementById('btnJoinRoom'));
const joinForm       = /** @type {HTMLFormElement}   */ (document.getElementById('joinForm'));
const joinCodeInput  = /** @type {HTMLInputElement}  */ (document.getElementById('joinCodeInput'));
const joinErrorEl    = /** @type {HTMLParagraphElement} */ (document.getElementById('joinError'));

/* ============================================================
 * Connection status → room bar badge
 * ============================================================ */

const CONN_LABEL = {
  connecting:   '⬤ Menghubungkan…',
  connected:    '⬤ Terhubung',
  disconnected: '⬤ Terputus',
  error:        '⬤ Error',
};

onStatusChange((status) => {
  connBadgeEl.dataset.status = status;
  connBadgeEl.textContent    = CONN_LABEL[status] ?? status;
});

onMemberChange((count) => {
  roomMembersEl.textContent = `👥 ${count} pemain`;
});

/* ============================================================
 * Enter room helper (shared by create + join flows)
 * ============================================================ */

/**
 * enterRoom - Join a Supabase channel and transition to the game screen.
 *
 * @param {string} code
 */
async function enterRoom(code) {
  const trimmed = code.trim().toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
    joinErrorEl.textContent = 'Kode harus 6 karakter (huruf/angka).';
    joinCodeInput.classList.add('error');
    return;
  }

  joinErrorEl.textContent = '';
  joinCodeInput.classList.remove('error');

  btnCreateRoom.disabled = true;
  btnCreateRoom.textContent = '✦ Menghubungkan…';
  if (btnJoinRoom) {
    btnJoinRoom.disabled = true;
    btnJoinRoom.textContent = '…';
  }

  try {
    await joinRoom(trimmed);
    roomCodeDisplay.textContent = trimmed;
    showGame();
    nextWord();
    updateRoleUI();
  } catch (err) {
    joinErrorEl.textContent = `Gagal terhubung: ${err.message}`;
    console.error('[enterRoom]', err);
  } finally {
    btnCreateRoom.disabled = false;
    btnCreateRoom.textContent = '✦ Buat Room';
    if (btnJoinRoom) {
      btnJoinRoom.disabled = false;
      btnJoinRoom.textContent = 'Masuk →';
    }
  }
}

/* ============================================================
 * Lobby events
 * ============================================================ */

btnCreateRoom.addEventListener('click', () => {
  const code = generateRoomCode();
  enterRoom(code);
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  enterRoom(joinCodeInput.value);
});

/* force uppercase while typing */
joinCodeInput.addEventListener('input', () => {
  const sel = joinCodeInput.selectionStart;
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinCodeInput.setSelectionRange(sel, sel);
});

btnLeaveRoom.addEventListener('click', showLobby);

/* ============================================================
 * Role management (Fase 2c: Penggambar vs Penonton)
 * ============================================================ */

function updateRoleUI() {
  if (state.isDrawer) {
    btnRoleToggle.classList.remove('is-spectator');
    btnRoleToggle.textContent = '🎨 Peran: Penggambar';
    canvasWrapper.classList.remove('is-spectator');
    drawingIndicator.textContent = '🎨 Mode Penggambar: Anda bisa menggambar di canvas';
  } else {
    btnRoleToggle.classList.add('is-spectator');
    btnRoleToggle.textContent = '👁️ Peran: Penonton';
    canvasWrapper.classList.add('is-spectator');
    drawingIndicator.textContent = '👁️ Mode Penonton: Hanya melihat (klik tombol peran di atas untuk menggambar)';
  }
}

btnRoleToggle.addEventListener('click', () => {
  state.isDrawer = !state.isDrawer;
  updateRoleUI();
});

/* ============================================================
 * State
 * ============================================================ */

/** @type {{ color: string, size: number, drawing: boolean, lastX: number, lastY: number, isDrawer: boolean }} */
const state = {
  color: '#f1f5f9',
  size: 12,
  drawing: false,
  lastX: 0,
  lastY: 0,
  isDrawer: true, // semua orang bisa menggambar secara default untuk testing
};

/* stroke batching state (Fase 2c) */
let currentBatchPoints = [];
let batchIntervalId = null;
let isBatchStart = false;

/* ============================================================
 * DOM refs
 * ============================================================ */
const canvas      = /** @type {HTMLCanvasElement} */ (document.getElementById('drawCanvas'));
const ctx         = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const brushCursor = /** @type {HTMLElement} */ (document.getElementById('brushCursor'));
const colorPicker = /** @type {HTMLInputElement} */ (document.getElementById('colorPicker'));
const clearBtn    = document.getElementById('clearBtn');

/* ============================================================
 * Canvas sizing — maintain 16:9, fill wrapper width
 * ============================================================ */

function resize() {
  const w = canvas.offsetWidth;
  if (w === 0) return; /* jangan ubah ukuran jika wrapper masih tersembunyi */

  /* snapshot current content */
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  if (canvas.width > 0 && canvas.height > 0) {
    tmp.getContext('2d').drawImage(canvas, 0, 0);
  }

  /* recalculate pixel size from CSS layout */
  const h = Math.round(w * (9 / 16));

  canvas.width  = w;
  canvas.height = h;
  canvas.style.height = `${h}px`;

  /* restore content and reset context state */
  if (tmp.width > 0 && tmp.height > 0) {
    ctx.drawImage(tmp, 0, 0);
  }
  applyCtxDefaults();
}

function applyCtxDefaults() {
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size;
}

/* ============================================================
 * Drawing & Real-time Stroke Batching (Fase 2c)
 * ============================================================ */

function canvasPoint(e) {
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

/**
 * flushStrokeBatch - Send buffered stroke points to room peers.
 * Interval: ~60ms.
 */
function flushStrokeBatch() {
  if (currentBatchPoints.length > 1) {
    sendStroke({
      points:    currentBatchPoints,
      color:     state.color,
      sizeRatio: state.size / canvas.width,
      isStart:   isBatchStart,
      isEnd:     false,
    });
    isBatchStart = false;
    /* retain the last point as the start of the next segment */
    currentBatchPoints = [currentBatchPoints[currentBatchPoints.length - 1]];
  }
}

function startDraw(e) {
  if (!state.isDrawer) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const { x, y } = canvasPoint(e);
  state.drawing = true;
  state.lastX   = x;
  state.lastY   = y;

  /* draw dot on local canvas */
  ctx.beginPath();
  ctx.arc(x, y, state.size / 2, 0, Math.PI * 2);
  ctx.fillStyle = state.color;
  ctx.fill();

  /* initialize batch with normalized coordinates */
  const nx = x / canvas.width;
  const ny = y / canvas.height;
  currentBatchPoints = [{ x: nx, y: ny }];
  isBatchStart = true;

  clearInterval(batchIntervalId);
  batchIntervalId = setInterval(flushStrokeBatch, 60);
}

function draw(e) {
  if (!state.drawing || !state.isDrawer) return;
  e.preventDefault();

  const { x, y } = canvasPoint(e);

  ctx.beginPath();
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size;
  ctx.moveTo(state.lastX, state.lastY);
  ctx.lineTo(x, y);
  ctx.stroke();

  state.lastX = x;
  state.lastY = y;

  /* append normalized point to batch */
  currentBatchPoints.push({
    x: x / canvas.width,
    y: y / canvas.height,
  });
}

function stopDraw(e) {
  if (!state.drawing || !state.isDrawer) return;
  e.preventDefault();
  state.drawing = false;
  ctx.closePath();

  clearInterval(batchIntervalId);
  batchIntervalId = null;

  /* flush remaining points and flag end of stroke */
  if (currentBatchPoints.length > 0) {
    sendStroke({
      points:    currentBatchPoints,
      color:     state.color,
      sizeRatio: state.size / canvas.width,
      isStart:   isBatchStart,
      isEnd:     true,
    });
  }
  currentBatchPoints = [];
  isBatchStart = false;
}

/* ============================================================
 * Peer Stroke Rendering (Fase 2c)
 * ============================================================ */

let peerDrawingTimeout = null;

function showPeerDrawing(from) {
  drawingIndicator.classList.add('is-peer-drawing');
  drawingIndicator.textContent = `🎨 Peer ${from.slice(0, 4)} sedang menggambar...`;

  clearTimeout(peerDrawingTimeout);
  peerDrawingTimeout = setTimeout(() => {
    drawingIndicator.classList.remove('is-peer-drawing');
    updateRoleUI();
  }, 1600);
}

function drawPeerStroke(strokeData) {
  if (!strokeData || !strokeData.points || strokeData.points.length === 0) return;

  const { points, color, sizeRatio, isStart } = strokeData;
  const strokeSize = (sizeRatio && canvas.width) ? (sizeRatio * canvas.width) : 12;

  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1 && isStart) {
    /* single dot */
    const pt = points[0];
    ctx.beginPath();
    ctx.arc(pt.x * canvas.width, pt.y * canvas.height, strokeSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else if (points.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = strokeSize;
    ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
    }
    ctx.stroke();
  }

  ctx.restore();
  applyCtxDefaults();
}

onStroke(({ stroke, from, self }) => {
  if (self) return; /* ignore local echo */
  showPeerDrawing(from);
  drawPeerStroke(stroke);
});

onClear(({ from, self }) => {
  if (self) return;
  clearCanvas();
  drawingIndicator.textContent = `🗑 Canvas dibersihkan oleh Peer ${from.slice(0, 4)}`;
  setTimeout(updateRoleUI, 2000);
});

/* ============================================================
 * Custom brush cursor
 * ============================================================ */

function updateCursor(e) {
  if (!state.isDrawer) return;
  const rect = canvas.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const y    = e.clientY - rect.top;

  const cssSize = state.size * (rect.width / canvas.width);

  brushCursor.style.left   = `${x}px`;
  brushCursor.style.top    = `${y}px`;
  brushCursor.style.width  = `${cssSize}px`;
  brushCursor.style.height = `${cssSize}px`;
}

function showCursor() {
  if (state.isDrawer) brushCursor.style.display = 'block';
}

function hideCursor() {
  brushCursor.style.display = 'none';
}

/* ============================================================
 * Toolbar — color
 * ============================================================ */

function setColor(hex) {
  state.color     = hex;
  ctx.strokeStyle = hex;
  colorPicker.value = hex;

  document.querySelectorAll('.swatch[data-color]').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === hex);
  });
}

document.querySelectorAll('.swatch[data-color]').forEach((btn) => {
  btn.addEventListener('click', () => setColor(btn.dataset.color));
});

colorPicker.addEventListener('input', (e) => setColor(e.target.value));

/* ============================================================
 * Toolbar — brush size
 * ============================================================ */

function setSize(px) {
  state.size    = px;
  ctx.lineWidth = px;

  document.querySelectorAll('.size-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.size) === px);
  });
}

document.querySelectorAll('.size-btn').forEach((btn) => {
  btn.addEventListener('click', () => setSize(Number(btn.dataset.size)));
});

/* ============================================================
 * Toolbar — clear
 * ============================================================ */

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

clearBtn.addEventListener('click', () => {
  clearCanvas();
  sendClear();
});

/* ============================================================
 * Canvas event listeners
 * ============================================================ */
canvas.addEventListener('pointerdown',  startDraw,  { passive: false });
canvas.addEventListener('pointermove',  draw,       { passive: false });
canvas.addEventListener('pointerup',    stopDraw,   { passive: false });
canvas.addEventListener('pointerleave', stopDraw,   { passive: false });

canvas.addEventListener('pointermove', updateCursor, { passive: true });
canvas.addEventListener('pointerenter', showCursor,  { passive: true });
canvas.addEventListener('pointerleave', hideCursor,  { passive: true });

/* ============================================================
 * Init
 * ============================================================ */

function init() {
  resize();
  applyCtxDefaults();
  updateRoleUI();
}

window.addEventListener('resize', resize);
init();

/* ============================================================
 * Guess box — Fase 1c
 * ============================================================ */

const WORD_LIST = [
  'kucing', 'anjing', 'rumah', 'pohon', 'mobil',
  'sepeda', 'matahari', 'bulan', 'bintang', 'awan',
  'hujan', 'gunung', 'laut', 'pantai', 'kapal',
  'pesawat', 'buku', 'pensil', 'payung', 'topi',
  'bunga', 'apel', 'pisang', 'jeruk', 'nasi',
  'pizza', 'roti', 'kunci', 'jam', 'telepon',
];

const guessState = {
  word:         '',
  scoreCorrect: 0,
  scoreWrong:   0,
};

const guessForm      = /** @type {HTMLFormElement}   */ (document.getElementById('guessForm'));
const guessInput     = /** @type {HTMLInputElement}  */ (document.getElementById('guessInput'));
const feedbackEl     = /** @type {HTMLParagraphElement} */ (document.getElementById('feedback'));
const wordSlotsEl    = /** @type {HTMLDivElement}    */ (document.getElementById('wordSlots'));
const wordHintEl     = /** @type {HTMLSpanElement}   */ (document.getElementById('wordHint'));
const scoreCorrectEl = /** @type {HTMLElement}      */ (document.getElementById('scoreCorrect'));
const scoreWrongEl   = /** @type {HTMLElement}      */ (document.getElementById('scoreWrong'));

let feedbackTimer = 0;

function pickWord() {
  if (WORD_LIST.length === 1) return WORD_LIST[0];
  let candidate;
  do {
    candidate = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  } while (candidate === guessState.word);
  return candidate;
}

function renderWordSlots() {
  wordSlotsEl.innerHTML = '';
  for (const ch of guessState.word) {
    const slot = document.createElement('div');
    if (ch === ' ') {
      slot.className = 'letter-slot space-gap';
    } else {
      slot.className = 'letter-slot';
      slot.dataset.char = ch;
    }
    wordSlotsEl.appendChild(slot);
  }
  const len = guessState.word.replace(/ /g, '').length;
  wordHintEl.textContent = `(${len} huruf)`;
}

function nextWord() {
  guessState.word = pickWord();
  renderWordSlots();
  clearCanvas();
  guessInput.value = '';
  guessInput.focus();
}

function showFeedback(text, kind, ms = 2200) {
  clearTimeout(feedbackTimer);
  feedbackEl.textContent = text;
  feedbackEl.className   = `feedback ${kind}`;
  feedbackTimer = setTimeout(() => {
    feedbackEl.classList.add('fade-out');
    feedbackTimer = setTimeout(() => {
      feedbackEl.textContent = '';
      feedbackEl.className   = 'feedback';
    }, 220);
  }, ms);
}

function triggerShake() {
  guessInput.classList.remove('shake');
  void guessInput.offsetWidth;
  guessInput.classList.add('shake');
  guessInput.addEventListener('animationend', () => {
    guessInput.classList.remove('shake');
  }, { once: true });
}

function handleGuess(e) {
  e.preventDefault();
  const raw   = guessInput.value;
  const guess = raw.trim().toLowerCase();
  if (!guess) return;

  const answer = guessState.word.trim().toLowerCase();
  if (guess === answer) {
    guessState.scoreCorrect += 1;
    scoreCorrectEl.textContent = String(guessState.scoreCorrect);
    showFeedback('🎉 Benar! Lanjut gambar berikutnya…', 'correct', 1500);
    setTimeout(nextWord, 1500);
  } else {
    guessState.scoreWrong += 1;
    scoreWrongEl.textContent = String(guessState.scoreWrong);
    showFeedback('❌ Coba lagi!', 'wrong', 1800);
    triggerShake();
    guessInput.select();
  }
}

guessForm.addEventListener('submit', handleGuess);

/* ============================================================
 * Chat — Fase 2b
 * ============================================================ */

const chatForm  = /** @type {HTMLFormElement}  */ (document.getElementById('chatForm'));
const chatInput = /** @type {HTMLInputElement} */ (document.getElementById('chatInput'));
const chatList  = /** @type {HTMLOListElement} */ (document.getElementById('chatList'));

function appendChatMessage({ text, from, ts, self }) {
  const li = document.createElement('li');
  li.className = `chat-msg ${self ? 'chat-msg--self' : 'chat-msg--peer'}`;

  const time  = new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const label = self ? 'Kamu' : `Peer ${from.slice(0, 4)}`;

  li.innerHTML = `
    <div class="chat-bubble">${escapeHtml(text)}</div>
    <span class="chat-meta">${escapeHtml(label)} · ${time}</span>
  `;

  chatList.appendChild(li);
  chatList.scrollTop = chatList.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

onChatMessage(appendChatMessage);

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.focus();

  try {
    await sendChat(text);
  } catch (err) {
    appendChatMessage({
      text: `⚠ Gagal kirim: ${err.message}`,
      from: 'system',
      ts:   Date.now(),
      self: false,
    });
  }
});
