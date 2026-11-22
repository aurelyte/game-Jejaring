/**
 * src/main.js — Tebak Gambar
 *
 * Fase 1b: canvas gambar lokal, 100% client-side.
 * Fase 1c: guess box lokal — tebak kata hardcoded, belum multiplayer.
 * Fase 2a: Supabase Realtime room — lobby, join/create, status koneksi.
 * Fase 2b: broadcast 'chat' — uji dua-arah sebelum stroke gambar.
 * Fase 2c: broadcast stroke real-time dengan batching ~60ms.
 * Fase 3a: Host-authoritative word generation + kata soal tersensor.
 * Fase 3b: Guess divalidasi oleh Host ('guess-attempt' & 'guess-result').
 *
 * Catatan Arsitektur (Host vs Client):
 *   [AUTHORITATIVE - HOST ONLY]:
 *     - Memilih kata rahasia dari WORD_LIST.
 *     - Menyimpan kata asli (plain text) hanya di memori lokal Host.
 *     - Menyiarkan event 'new-word' berisi hint ke room (kata asli TIDAK dikirim).
 *     - Menerima event 'guess-attempt' dari pemain, memvalidasi dengan kata asli.
 *     - Menyiarkan event 'guess-result' (status benar/salah, kata asli jika benar).
 *     - Menjadwalkan ronde berikutnya jika ada pemain yang menebak benar.
 *   [CLIENT - RENDER ONLY]:
 *     - Mengirimkan 'guess-attempt' ke Host saat submit form tebak (tanpa validasi lokal).
 *     - Menerima 'guess-result' dari Host, lalu memperbarui skor, status kata, dan chat.
 *     - Menerima 'new-word' yang berisi hint tersensor (jumlah huruf dan slot underscore).
 */

import {
  generateRoomCode,
  joinRoom,
  leaveRoom,
  sendChat,
  sendStroke,
  sendClear,
  sendNewWord,
  sendGuessAttempt,
  sendGuessResult,
  onStatusChange,
  onMemberChange,
  onChatMessage,
  onStroke,
  onClear,
  onNewWord,
  onGuessAttempt,
  onGuessResult,
  getSelfKey,
} from './room.js';

/* ============================================================
 * State Aplikasi
 * ============================================================ */

/**
 * @type {{
 *   isHost: boolean,
 *   isDrawer: boolean,
 *   color: string,
 *   size: number,
 *   drawing: boolean,
 *   lastX: number,
 *   lastY: number
 * }}
 */
const state = {
  isHost:   false, // [AUTHORITATIVE]: true jika membuat room, false jika join
  isDrawer: false, // true jika saat ini punya izin menggambar di canvas
  color:    '#f1f5f9',
  size:     12,
  drawing:  false,
  lastX:    0,
  lastY:    0,
};

/* Skor permainan tersinkronisasi berdasarkan 'guess-result' */
const scoreState = {
  correct: 0,
  wrong:   0,
};

/* stroke batching buffer (Fase 2c) */
let currentBatchPoints = [];
let batchIntervalId    = null;
let isBatchStart       = false;

/* ============================================================
 * [AUTHORITATIVE - HOST ONLY] Word Pool & Host State
 * ============================================================
 * Daftar kata dan kata rahasia yang aktif hanya disimpan dan dikelola
 * oleh Host. Penebak tidak memiliki akses ke plain text kata rahasia.
 */

const WORD_LIST = [
  'kucing', 'anjing', 'rumah', 'pohon', 'mobil',
  'sepeda', 'matahari', 'bulan', 'bintang', 'awan',
  'hujan', 'gunung', 'laut', 'pantai', 'kapal',
  'pesawat', 'buku', 'pensil', 'payung', 'topi',
  'bunga', 'apel', 'pisang', 'jeruk', 'nasi',
  'pizza', 'roti', 'kunci', 'jam', 'telepon',
];

/** State yang HANYA diketahui dan dikelola oleh Host */
const hostState = {
  secretWord: '',
};

/* ============================================================
 * DOM refs
 * ============================================================ */

const lobbyScreen      = /** @type {HTMLElement}       */ (document.getElementById('lobbyScreen'));
const gameScreen       = /** @type {HTMLElement}       */ (document.getElementById('gameScreen'));

/* Room bar & Role indicators */
const roomCodeDisplay  = /** @type {HTMLElement}       */ (document.getElementById('roomCodeDisplay'));
const roomMembersEl    = /** @type {HTMLElement}       */ (document.getElementById('roomMembers'));
const connBadgeEl      = /** @type {HTMLElement}       */ (document.getElementById('connBadge'));
const roleBadge        = /** @type {HTMLElement}       */ (document.getElementById('roleBadge'));
const btnLeaveRoom     = /** @type {HTMLButtonElement}  */ (document.getElementById('btnLeaveRoom'));
const drawingIndicator = /** @type {HTMLElement}       */ (document.getElementById('drawingIndicator'));
const canvasWrapper    = /** @type {HTMLElement}       */ (document.getElementById('canvasWrapper'));

/* Lobby inputs */
const btnCreateRoom    = /** @type {HTMLButtonElement}  */ (document.getElementById('btnCreateRoom'));
const btnJoinRoom      = /** @type {HTMLButtonElement}  */ (document.getElementById('btnJoinRoom'));
const joinForm         = /** @type {HTMLFormElement}    */ (document.getElementById('joinForm'));
const joinCodeInput    = /** @type {HTMLInputElement}   */ (document.getElementById('joinCodeInput'));
const joinErrorEl      = /** @type {HTMLParagraphElement}*/ (document.getElementById('joinError'));

/* Canvas & Toolbar */
const canvas           = /** @type {HTMLCanvasElement}  */ (document.getElementById('drawCanvas'));
const ctx              = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const brushCursor      = /** @type {HTMLElement}       */ (document.getElementById('brushCursor'));
const colorPicker      = /** @type {HTMLInputElement}   */ (document.getElementById('colorPicker'));
const clearBtn         = document.getElementById('clearBtn');

/* Word display & Guess box */
const wordLabelEl      = /** @type {HTMLElement}       */ (document.getElementById('wordLabel'));
const wordSlotsEl      = /** @type {HTMLDivElement}    */ (document.getElementById('wordSlots'));
const wordHintEl       = /** @type {HTMLSpanElement}   */ (document.getElementById('wordHint'));
const btnHostNextWord  = /** @type {HTMLButtonElement}  */ (document.getElementById('btnHostNextWord'));
const hostGuessNotice  = /** @type {HTMLElement}       */ (document.getElementById('hostGuessNotice'));
const guessForm        = /** @type {HTMLFormElement}   */ (document.getElementById('guessForm'));
const guessInput       = /** @type {HTMLInputElement}  */ (document.getElementById('guessInput'));
const feedbackEl       = /** @type {HTMLParagraphElement} */ (document.getElementById('feedback'));
const scoreCorrectEl   = /** @type {HTMLElement}       */ (document.getElementById('scoreCorrect'));
const scoreWrongEl     = /** @type {HTMLElement}       */ (document.getElementById('scoreWrong'));

/* Chat */
const chatForm         = /** @type {HTMLFormElement}   */ (document.getElementById('chatForm'));
const chatInput        = /** @type {HTMLInputElement}  */ (document.getElementById('chatInput'));
const chatList         = /** @type {HTMLOListElement}  */ (document.getElementById('chatList'));

/* ============================================================
 * Screen Switching
 * ============================================================ */

function showGame() {
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  requestAnimationFrame(() => {
    resize();
  });
}

async function showLobby() {
  await leaveRoom();
  state.isHost            = false;
  state.isDrawer          = false;
  hostState.secretWord    = '';
  scoreState.correct      = 0;
  scoreState.wrong        = 0;
  scoreCorrectEl.textContent = '0';
  scoreWrongEl.textContent   = '0';
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  joinCodeInput.value     = '';
  joinErrorEl.textContent = '';
}

/* ============================================================
 * [AUTHORITATIVE - HOST] Pemilihan Kata & Penyiaran Soal
 * ============================================================
 * Hanya dijalankan oleh Host:
 * 1. Memilih kata rahasia secara acak.
 * 2. Mengirimkan HANYA versi tersensor (underscore/slot & panjang) ke room.
 * 3. Menampilkan kata asli di layar Host sendiri.
 * ============================================================ */

function pickWord() {
  if (WORD_LIST.length === 1) return WORD_LIST[0];
  let candidate;
  do {
    candidate = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  } while (candidate === hostState.secretWord);
  return candidate;
}

/**
 * hostPickAndBroadcastWord - [HOST AUTHORITATIVE]
 * Generate kata soal baru dan broadcast hint tersensor ke room.
 */
function hostPickAndBroadcastWord() {
  if (!state.isHost) return;

  const word = pickWord();
  hostState.secretWord = word;

  /* Bersihkan canvas host dan siarkan clear ke peer */
  clearCanvas();
  sendClear();

  /* Siapkan hint tersensor (kata asli TIDAK dikirim) */
  const cleanLen    = word.replace(/ /g, '').length;
  const maskedSlots = Array.from(word).map((ch) => (ch === ' ' ? ' ' : '_'));

  const hintPayload = {
    length: cleanLen,
    slots:  maskedSlots,
  };

  /* Siarkan hint tersensor ke room */
  sendNewWord(hintPayload);

  /* Render kata asli di layar Host */
  renderHostWordDisplay(word);
}

/** Render kata asli di layar Host */
function renderHostWordDisplay(word) {
  wordLabelEl.textContent = 'Kata Anda:';
  wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(word)}</span>`;
  wordHintEl.textContent  = '(Hanya Anda yang tahu — gambarlah kata ini!)';
}

/* Tombol ganti kata untuk Host */
btnHostNextWord.addEventListener('click', () => {
  if (state.isHost) {
    hostPickAndBroadcastWord();
  }
});

/* ============================================================
 * [AUTHORITATIVE - HOST] Validasi Tebakan (Fase 3b)
 * ============================================================
 * HANYA Host yang menerima dan mengevaluasi 'guess-attempt':
 * - Mengecek apakah tebakan cocok (case-insensitive & trim)
 *   dengan kata asli yang dipegang host (hostState.secretWord).
 * - Menyiarkan event 'guess-result' ke semua client di room.
 * - Jika tebakan BENAR, Host menyertakan kata asli dalam broadcast
 *   dan menjadwalkan ronde baru (hostPickAndBroadcastWord).
 * ============================================================ */

let nextRoundTimer = null;

onGuessAttempt(async ({ guess, from }) => {
  /* HANYA Host yang memiliki wewenang memvalidasi tebakan */
  if (!state.isHost) return;
  if (!hostState.secretWord) return;

  const cleanedGuess  = guess.trim().toLowerCase();
  const cleanedAnswer = hostState.secretWord.trim().toLowerCase();
  const isCorrect     = (cleanedGuess === cleanedAnswer);

  /* Siarkan hasil evaluasi ke seluruh client di room */
  await sendGuessResult({
    isCorrect,
    guesserId: from,
    guess,
    word: isCorrect ? hostState.secretWord : null,
  });

  /* Jika benar, Host otomatis memulai ronde baru setelah jeda */
  if (isCorrect) {
    clearTimeout(nextRoundTimer);
    nextRoundTimer = setTimeout(() => {
      if (state.isHost) {
        hostPickAndBroadcastWord();
      }
    }, 3200);
  }
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Penerima Soal Tersensor
 * ============================================================
 * Dijalankan oleh client Penebak saat menerima event 'new-word':
 * Penebak hanya menerima hint.slots (underscore) dan hint.length.
 * ============================================================ */

function renderGuesserWordSlots(hint) {
  wordLabelEl.textContent = 'Tebak kata:';
  wordSlotsEl.innerHTML   = '';

  if (!hint || !hint.slots) {
    wordHintEl.textContent = '(Menunggu Host memilih kata...)';
    return;
  }

  for (const ch of hint.slots) {
    const slot = document.createElement('div');
    slot.className = ch === ' ' ? 'letter-slot space-gap' : 'letter-slot';
    wordSlotsEl.appendChild(slot);
  }

  wordHintEl.textContent = `(${hint.length} huruf)`;
}

/* Event listener 'new-word' dari Supabase Realtime */
onNewWord(({ hint, self }) => {
  if (self) return; /* Host sudah merender kata aslinya secara lokal */

  /* Penebak me-render slot tersensor */
  renderGuesserWordSlots(hint);
  clearCanvas();
  showFeedback('🎲 Host telah memilih kata baru! Perhatikan gambar dan tebak.', 'correct', 2500);
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Update UI Berdasarkan 'guess-result'
 * ============================================================
 * Semua client (Host dan Penebak) memperbarui UI secara sinkron
 * berdasarkan hasil validasi yang disiarkan oleh Host (bukan validasi sendiri):
 * ============================================================ */

onGuessResult(({ isCorrect, guesserId, guess, word }) => {
  const isMyGuess   = (guesserId === getSelfKey());
  const guesserName = isMyGuess ? 'Kamu' : `Peer ${guesserId.slice(0, 4)}`;

  if (isCorrect) {
    /* 1. Update skor benar */
    scoreState.correct += 1;
    scoreCorrectEl.textContent = String(scoreState.correct);

    /* 2. Tampilkan kata yang tertebak di layar untuk semua pemain */
    wordLabelEl.textContent = 'Kata tertebak:';
    wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(word)}</span>`;
    wordHintEl.textContent  = `(Ditebak oleh ${guesserName}! Menyiapkan ronde berikutnya...)`;

    /* 3. Feedback visual */
    if (isMyGuess) {
      showFeedback(`🎉 BENAR! Kamu berhasil menebak: "${word}"`, 'correct', 3000);
    } else {
      showFeedback(`🎉 ${guesserName} berhasil menebak: "${word}"!`, 'correct', 3000);
    }

    /* 4. Notifikasi publik di chat */
    appendChatMessage({
      text: `🏆 [TEBAKAN BENAR] ${guesserName} berhasil menebak: "${word}"!`,
      from: 'system',
      ts:   Date.now(),
      self: isMyGuess,
    });
  } else {
    /* 1. Update skor coba lagi / salah */
    scoreState.wrong += 1;
    scoreWrongEl.textContent = String(scoreState.wrong);

    /* 2. Feedback jika tebakan salah berasal dari client ini */
    if (isMyGuess) {
      showFeedback(`❌ "${guess}" salah! Coba lagi.`, 'wrong', 1800);
      triggerShake();
    }

    /* 3. Catat di chat sebagai tebakan */
    appendChatMessage({
      text: `[Tebakan]: ${guess} ❌`,
      from: guesserId,
      ts:   Date.now(),
      self: isMyGuess,
    });
  }
});

/* ============================================================
 * Role Management (Host vs Guesser)
 * ============================================================ */

function updateRoleUI() {
  if (state.isHost) {
    /* [AUTHORITATIVE - HOST]: Host adalah Penggambar */
    state.isDrawer = true;

    roleBadge.textContent = '👑 Host (Penggambar)';
    roleBadge.className   = 'role-badge role-badge--host';

    canvasWrapper.classList.remove('is-guesser');
    btnHostNextWord.classList.remove('hidden');
    hostGuessNotice.classList.remove('hidden');
    guessForm.classList.add('hidden');

    drawingIndicator.textContent = '🎨 Anda adalah Host & Penggambar. Gambar kata rahasia Anda di canvas!';
    drawingIndicator.className   = 'drawing-indicator';
  } else {
    /* [CLIENT - GUESSER]: Non-host adalah Penebak / Penonton */
    state.isDrawer = false;

    roleBadge.textContent = '🔍 Penebak';
    roleBadge.className   = 'role-badge role-badge--guesser';

    canvasWrapper.classList.add('is-guesser');
    btnHostNextWord.classList.add('hidden');
    hostGuessNotice.classList.add('hidden');
    guessForm.classList.remove('hidden');

    drawingIndicator.textContent = '🔍 Anda adalah Penebak. Perhatikan gambar dari Host dan tebak di bawah!';
    drawingIndicator.className   = 'drawing-indicator';
  }
}

/* ============================================================
 * Connection status & Presence listeners
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

  /* [AUTHORITATIVE - HOST]: Jika ada pemain baru masuk saat permainan
     berlangsung, Host otomatis mengirim ulang hint tersensor agar pemain baru
     langsung mendapatkan pola huruf terkini tanpa menunggu ronde berikutnya. */
  if (state.isHost && hostState.secretWord) {
    const cleanLen    = hostState.secretWord.replace(/ /g, '').length;
    const maskedSlots = Array.from(hostState.secretWord).map((ch) => (ch === ' ' ? ' ' : '_'));
    sendNewWord({
      length: cleanLen,
      slots:  maskedSlots,
    });
  }
});

/* ============================================================
 * Enter room helper (shared by create + join flows)
 * ============================================================ */

/**
 * enterRoom - Masuk room dan set otoritas Host/Non-Host.
 *
 * @param {string} code
 * @param {boolean} isHost - true jika pembuat room, false jika join
 */
async function enterRoom(code, isHost = false) {
  const trimmed = code.trim().toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
    joinErrorEl.textContent = 'Kode harus 6 karakter (huruf/angka).';
    joinCodeInput.classList.add('error');
    return;
  }

  joinErrorEl.textContent = '';
  joinCodeInput.classList.remove('error');

  btnCreateRoom.disabled    = true;
  btnCreateRoom.textContent = '✦ Menghubungkan…';
  if (btnJoinRoom) {
    btnJoinRoom.disabled    = true;
    btnJoinRoom.textContent = '…';
  }

  try {
    await joinRoom(trimmed);

    /* Set flag isHost di state lokal */
    state.isHost = isHost;
    roomCodeDisplay.textContent = trimmed;

    showGame();
    updateRoleUI();

    if (state.isHost) {
      /* [AUTHORITATIVE - HOST]: Host langsung memilih kata pertama */
      hostPickAndBroadcastWord();
    } else {
      /* [CLIENT - GUESSER]: Penebak menunggu hint dari Host */
      renderGuesserWordSlots(null);
    }
  } catch (err) {
    joinErrorEl.textContent = `Gagal terhubung: ${err.message}`;
    console.error('[enterRoom]', err);
  } finally {
    btnCreateRoom.disabled    = false;
    btnCreateRoom.textContent = '✦ Buat Room';
    if (btnJoinRoom) {
      btnJoinRoom.disabled    = false;
      btnJoinRoom.textContent = 'Masuk →';
    }
  }
}

/* ============================================================
 * Lobby events
 * ============================================================ */

/* Pembuat room otomatis menjadi Host (isHost = true) */
btnCreateRoom.addEventListener('click', () => {
  const code = generateRoomCode();
  enterRoom(code, true);
});

/* Pemain yang join bukan Host (isHost = false) */
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  enterRoom(joinCodeInput.value, false);
});

/* Force uppercase pada input kode */
joinCodeInput.addEventListener('input', () => {
  const sel = joinCodeInput.selectionStart;
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinCodeInput.setSelectionRange(sel, sel);
});

btnLeaveRoom.addEventListener('click', showLobby);

/* ============================================================
 * Canvas sizing — maintain 16:9, fill wrapper width
 * ============================================================ */

function resize() {
  const w = canvas.offsetWidth;
  if (w === 0) return;

  const tmp  = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  if (canvas.width > 0 && canvas.height > 0) {
    tmp.getContext('2d').drawImage(canvas, 0, 0);
  }

  const h = Math.round(w * (9 / 16));
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.height = `${h}px`;

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
    currentBatchPoints = [currentBatchPoints[currentBatchPoints.length - 1]];
  }
}

function startDraw(e) {
  /* Hanya pemain dengan izin drawer (Host) yang bisa menggambar */
  if (!state.isDrawer) return;

  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const { x, y } = canvasPoint(e);
  state.drawing  = true;
  state.lastX    = x;
  state.lastY    = y;

  ctx.beginPath();
  ctx.arc(x, y, state.size / 2, 0, Math.PI * 2);
  ctx.fillStyle = state.color;
  ctx.fill();

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
 * Peer Stroke Rendering (Client me-render stroke dari Host)
 * ============================================================ */

let peerDrawingTimeout = null;

function showPeerDrawing(from) {
  drawingIndicator.classList.add('is-peer-drawing');
  drawingIndicator.textContent = `🎨 Host (${from.slice(0, 4)}) sedang menggambar...`;

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
  if (self) return;
  showPeerDrawing(from);
  drawPeerStroke(stroke);
});

onClear(({ from, self }) => {
  if (self) return;
  clearCanvas();
  drawingIndicator.textContent = `🗑 Canvas dibersihkan oleh ${from.slice(0, 4)}`;
  setTimeout(updateRoleUI, 2000);
});

/* ============================================================
 * Custom Brush Cursor
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
 * Toolbar Events
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

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

clearBtn.addEventListener('click', () => {
  clearCanvas();
  sendClear();
});

/* Canvas event listeners */
canvas.addEventListener('pointerdown',  startDraw,  { passive: false });
canvas.addEventListener('pointermove',  draw,       { passive: false });
canvas.addEventListener('pointerup',    stopDraw,   { passive: false });
canvas.addEventListener('pointerleave', stopDraw,   { passive: false });

canvas.addEventListener('pointermove', updateCursor, { passive: true });
canvas.addEventListener('pointerenter', showCursor,  { passive: true });
canvas.addEventListener('pointerleave', hideCursor,  { passive: true });

/* ============================================================
 * [CLIENT - ACTION] Guess Box Handling (Penebak)
 * ============================================================
 * Penebak mengirim tebakan via event 'guess-attempt' ke Host
 * tanpa melakukan validasi lokal.
 * ============================================================ */

let feedbackTimer = 0;

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

/* Saat penebak mengirim tebakan di form tebak */
guessForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = guessInput.value.trim();
  if (!raw) return;

  guessInput.value = '';

  /* Kirim tebakan ke Host untuk divalidasi */
  try {
    await sendGuessAttempt(raw);
    showFeedback(`Memeriksa tebakan: "${raw}"…`, 'correct', 1200);
  } catch (err) {
    showFeedback(`Gagal kirim: ${err.message}`, 'wrong', 1800);
    triggerShake();
  }
});

/* ============================================================
 * Chat Handling (Fase 2b)
 * ============================================================ */

function appendChatMessage({ text, from, ts, self }) {
  const li = document.createElement('li');
  li.className = `chat-msg ${self ? 'chat-msg--self' : 'chat-msg--peer'}`;

  const time  = new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const label = self ? 'Kamu' : (from === 'system' ? 'Sistem' : `Peer ${from.slice(0, 4)}`);

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
