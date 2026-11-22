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
 * Fase 3c: Sistem giliran round-robin ('turn-change') + countdown timer 60s.
 *
 * Catatan Arsitektur (Host vs Client):
 *   [AUTHORITATIVE - HOST ONLY]:
 *     - Mengelola urutan pemain & giliran round-robin dari presence room.
 *     - Memilih kata soal berikutnya dari WORD_LIST.
 *     - Menyiarkan event 'turn-change' (menentukan siapa drawer berikutnya & durasi).
 *     - Mengelola countdown timer 60s per ronde; jika habis, ganti giliran otomatis.
 *     - Menerima dan memvalidasi 'guess-attempt', menyiarkan 'guess-result'.
 *   [CLIENT - RENDER ONLY]:
 *     - Menerima 'turn-change': jika client adalah drawer, toolbar aktif; jika bukan,
 *       canvas view-only (read-only) dan toolbar disembunyikan.
 *     - Menampilkan sinkronisasi hitung mundur timer.
 *     - Mengirim tebakan via 'guess-attempt' dan menerima hasil via 'guess-result'.
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
  sendTurnChange,
  onStatusChange,
  onMemberChange,
  onChatMessage,
  onStroke,
  onClear,
  onNewWord,
  onGuessAttempt,
  onGuessResult,
  onTurnChange,
  getSelfKey,
  getRoomMemberKeys,
} from './room.js';

/* ============================================================
 * State Aplikasi
 * ============================================================ */

/**
 * @type {{
 *   isHost: boolean,
 *   isDrawer: boolean,
 *   currentDrawerId: string,
 *   color: string,
 *   size: number,
 *   drawing: boolean,
 *   lastX: number,
 *   lastY: number
 * }}
 */
const state = {
  isHost:          false, // [AUTHORITATIVE]: true jika membuat room, false jika join
  isDrawer:        false, // true jika saat ini adalah giliran menggambar di canvas
  currentDrawerId: '',
  color:           '#f1f5f9',
  size:            12,
  drawing:         false,
  lastX:           0,
  lastY:           0,
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
 */

const WORD_LIST = [
  'kucing', 'anjing', 'rumah', 'pohon', 'mobil',
  'sepeda', 'matahari', 'bulan', 'bintang', 'awan',
  'hujan', 'gunung', 'laut', 'pantai', 'kapal',
  'pesawat', 'buku', 'pensil', 'payung', 'topi',
  'bunga', 'apel', 'pisang', 'jeruk', 'nasi',
  'pizza', 'roti', 'kunci', 'jam', 'telepon',
];

/** State yang HANYA diketahui dan dikelola secara otoritatif oleh Host */
const hostState = {
  secretWord:         '',
  playerOrder:        [], // urutan ID pemain round-robin
  currentDrawerIndex: -1, // indeks drawer saat ini di playerOrder
  turnDuration:       60, // 60 detik per giliran
  timerInterval:      null,
  secondsRemaining:   60,
  isRoundEnding:      false,
};

/* ============================================================
 * DOM refs
 * ============================================================ */

const lobbyScreen      = /** @type {HTMLElement}       */ (document.getElementById('lobbyScreen'));
const gameScreen       = /** @type {HTMLElement}       */ (document.getElementById('gameScreen'));

/* Room bar & Status indicators */
const roomCodeDisplay  = /** @type {HTMLElement}       */ (document.getElementById('roomCodeDisplay'));
const roomMembersEl    = /** @type {HTMLElement}       */ (document.getElementById('roomMembers'));
const connBadgeEl      = /** @type {HTMLElement}       */ (document.getElementById('connBadge'));
const timerBadgeEl     = /** @type {HTMLElement}       */ (document.getElementById('timerBadge'));
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

/* Timer lokal client */
let localTimerInterval = null;
let nextRoundTimer     = null;

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

  clearInterval(hostState.timerInterval);
  clearInterval(localTimerInterval);
  clearTimeout(nextRoundTimer);

  state.isHost            = false;
  state.isDrawer          = false;
  state.currentDrawerId   = '';
  hostState.secretWord    = '';
  hostState.playerOrder   = [];
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
 * [AUTHORITATIVE - HOST ONLY] Round-Robin & Timer Giliran (Fase 3c)
 * ============================================================
 * HANYA Host yang menjalankan fungsi ini:
 * 1. Menentukan urutan pemain berdasarkan daftar presence di room.
 * 2. Menghitung giliran round-robin (currentDrawerIndex).
 * 3. Memilih kata baru dari WORD_LIST.
 * 4. Menyiarkan event 'turn-change' ke seluruh client.
 * 5. Menjalankan countdown timer 60 detik secara authoritative.
 * 6. Jika waktu habis, Host menyiarkan kata asli dan ganti giliran.
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
 * hostStartNextTurn - [HOST AUTHORITATIVE]
 * Mulai giliran baru round-robin, tentukan drawer, dan siarkan 'turn-change'.
 */
function hostStartNextTurn() {
  if (!state.isHost) return;

  clearInterval(hostState.timerInterval);
  clearTimeout(nextRoundTimer);
  hostState.isRoundEnding = false;

  /* Sinkronkan daftar pemain dari presence room */
  const members = getRoomMemberKeys();
  if (members.length === 0) {
    hostState.playerOrder = [getSelfKey()];
  } else {
    /* Pertahankan urutan yang ada, tambahkan anggota baru di akhir */
    const existing = hostState.playerOrder.filter((k) => members.includes(k));
    const brandNew = members.filter((k) => !existing.includes(k));
    hostState.playerOrder = [...existing, ...brandNew];
  }

  if (hostState.playerOrder.length === 0) {
    hostState.playerOrder = [getSelfKey()];
  }

  /* Giliran round-robin */
  hostState.currentDrawerIndex = (hostState.currentDrawerIndex + 1) % hostState.playerOrder.length;
  const currentDrawerId        = hostState.playerOrder[hostState.currentDrawerIndex];

  /* Host memilih kata baru */
  const word = pickWord();
  hostState.secretWord       = word;
  hostState.secondsRemaining = hostState.turnDuration;

  /* Siapkan hint tersensor untuk penebak */
  const cleanLen    = word.replace(/ /g, '').length;
  const maskedSlots = Array.from(word).map((ch) => (ch === ' ' ? ' ' : '_'));
  const hint        = { length: cleanLen, slots: maskedSlots };

  /* Bersihkan canvas */
  clearCanvas();
  sendClear();

  /* Siarkan event 'turn-change' ke seluruh client di room */
  sendTurnChange({
    drawerId:   currentDrawerId,
    drawerWord: word, // plaintext hanya ditampilkan untuk client dengan getSelfKey() === drawerId
    hint:       hint,
    duration:   hostState.turnDuration,
    startedAt:  Date.now(),
  });

  /* Host menjalankan countdown timer 60 detik secara authoritative */
  hostState.timerInterval = setInterval(() => {
    hostState.secondsRemaining -= 1;

    if (hostState.secondsRemaining <= 0) {
      clearInterval(hostState.timerInterval);
      hostHandleTurnTimeout();
    }
  }, 1000);
}

/**
 * hostHandleTurnTimeout - [HOST AUTHORITATIVE]
 * Dipanggil saat timer 60s habis. Mengumumkan kata asli dan ganti giliran.
 */
function hostHandleTurnTimeout() {
  if (!state.isHost || hostState.isRoundEnding) return;
  hostState.isRoundEnding = true;

  const word = hostState.secretWord;

  /* Siarkan hasil timeout: ronde selesai, buka kata asli untuk semua pemain */
  sendGuessResult({
    isCorrect: false,
    guesserId: 'timeout',
    guess:     '(Waktu Habis)',
    word:      word,
  });

  /* Berpindah ke giliran berikutnya setelah jeda 3.5 detik */
  clearTimeout(nextRoundTimer);
  nextRoundTimer = setTimeout(() => {
    if (state.isHost) {
      hostStartNextTurn();
    }
  }, 3500);
}

/* Tombol ganti giliran manual untuk Host */
btnHostNextWord.addEventListener('click', () => {
  if (state.isHost) {
    hostStartNextTurn();
  }
});

/* ============================================================
 * [AUTHORITATIVE - HOST ONLY] Validasi Tebakan (Fase 3b)
 * ============================================================ */

onGuessAttempt(async ({ guess, from }) => {
  if (!state.isHost || hostState.isRoundEnding) return;
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

  /* Jika tebakan benar, Host mengakhiri ronde dan menjadwalkan giliran baru */
  if (isCorrect) {
    hostState.isRoundEnding = true;
    clearInterval(hostState.timerInterval);

    clearTimeout(nextRoundTimer);
    nextRoundTimer = setTimeout(() => {
      if (state.isHost) {
        hostStartNextTurn();
      }
    }, 3500);
  }
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Penanganan 'turn-change' (Fase 3c)
 * ============================================================
 * Semua client memperbarui status drawer, toolbar, dan timer:
 * ============================================================ */

function updateTimerDisplay(seconds) {
  timerBadgeEl.textContent = `⏱️ ${seconds}s`;
  if (seconds <= 10) {
    timerBadgeEl.classList.add('is-urgent');
  } else {
    timerBadgeEl.classList.remove('is-urgent');
  }
}

function startLocalTimer(duration, startedAt) {
  clearInterval(localTimerInterval);

  function tick() {
    const elapsed   = Math.floor((Date.now() - startedAt) / 1000);
    const remaining = Math.max(0, duration - elapsed);
    updateTimerDisplay(remaining);
    if (remaining <= 0) {
      clearInterval(localTimerInterval);
    }
  }

  tick();
  localTimerInterval = setInterval(tick, 1000);
}

function renderGuesserWordSlots(hint) {
  wordLabelEl.textContent = 'Tebak kata:';
  wordSlotsEl.innerHTML   = '';

  if (!hint || !hint.slots) {
    wordHintEl.textContent = '(Menunggu giliran dimulai...)';
    return;
  }

  for (const ch of hint.slots) {
    const slot = document.createElement('div');
    slot.className = ch === ' ' ? 'letter-slot space-gap' : 'letter-slot';
    wordSlotsEl.appendChild(slot);
  }

  wordHintEl.textContent = `(${hint.length} huruf)`;
}

/* Event listener 'turn-change' dari Host */
onTurnChange(({ drawerId, drawerWord, hint, duration, startedAt }) => {
  clearCanvas();
  startLocalTimer(duration, startedAt);

  state.currentDrawerId = drawerId;
  const isMeDrawer      = (drawerId === getSelfKey());
  state.isDrawer        = isMeDrawer;

  if (isMeDrawer) {
    /* [DRAWER]: Canvas aktif untuk menggambar, toolbar terbuka */
    canvasWrapper.classList.remove('is-guesser');
    hostGuessNotice.classList.remove('hidden');
    hostGuessNotice.textContent = '🎨 Anda sedang menggambar! Biarkan pemain lain menebak.';
    guessForm.classList.add('hidden');

    /* Tampilkan kata rahasia yang harus digambar */
    wordLabelEl.textContent = 'Kata untuk digambar:';
    wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(drawerWord)}</span>`;
    wordHintEl.textContent  = '(Hanya Anda yang tahu — gambarlah kata ini!)';

    drawingIndicator.textContent = '🎨 Giliran Anda Menggambar! Gambarlah di canvas.';
    drawingIndicator.className   = 'drawing-indicator';

    showFeedback('🎨 Giliran Anda menggambar!', 'correct', 2500);
  } else {
    /* [GUESSER]: Canvas read-only, toolbar disembunyikan, form tebak aktif */
    canvasWrapper.classList.add('is-guesser');
    hostGuessNotice.classList.add('hidden');
    guessForm.classList.remove('hidden');

    /* Tampilkan slot tersensor */
    renderGuesserWordSlots(hint);

    const drawerLabel = (drawerId === getSelfKey() ? 'Kamu' : `Peer ${drawerId.slice(0, 4)}`);
    drawingIndicator.textContent = `🔍 ${drawerLabel} sedang menggambar. Perhatikan canvas dan tebak di bawah!`;
    drawingIndicator.className   = 'drawing-indicator';

    showFeedback(`🎨 Giliran ${drawerLabel} menggambar!`, 'correct', 2500);
  }

  /* Tombol ganti giliran manual hanya tampil pada Host */
  if (state.isHost) {
    btnHostNextWord.classList.remove('hidden');
  } else {
    btnHostNextWord.classList.add('hidden');
  }
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Update UI Berdasarkan 'guess-result'
 * ============================================================ */

onGuessResult(({ isCorrect, guesserId, guess, word }) => {
  const isMyGuess   = (guesserId === getSelfKey());
  const guesserName = isMyGuess ? 'Kamu' : `Peer ${guesserId.slice(0, 4)}`;

  /* Hentikan countdown timer lokal jika ronde berakhir */
  if (isCorrect || guesserId === 'timeout') {
    clearInterval(localTimerInterval);
    updateTimerDisplay(0);
  }

  if (isCorrect) {
    /* Update skor */
    scoreState.correct += 1;
    scoreCorrectEl.textContent = String(scoreState.correct);

    /* Buka kata rahasia di layar semua pemain */
    wordLabelEl.textContent = 'Kata tertebak:';
    wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(word)}</span>`;
    wordHintEl.textContent  = `(Ditebak oleh ${guesserName}! Giliran berikutnya segera dimulai...)`;

    /* Feedback */
    if (isMyGuess) {
      showFeedback(`🎉 BENAR! Kamu berhasil menebak: "${word}"`, 'correct', 3000);
    } else {
      showFeedback(`🎉 ${guesserName} berhasil menebak: "${word}"!`, 'correct', 3000);
    }

    /* Notifikasi chat */
    appendChatMessage({
      text: `🏆 [TEBAKAN BENAR] ${guesserName} berhasil menebak: "${word}"!`,
      from: 'system',
      ts:   Date.now(),
      self: isMyGuess,
    });
  } else if (guesserId === 'timeout') {
    /* Waktu habis tanpa penebak yang tepat */
    wordLabelEl.textContent = 'Waktu habis! Kata aslinya:';
    wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(word)}</span>`;
    wordHintEl.textContent  = '(Ronde berakhir karena waktu habis)';

    showFeedback(`⏰ Waktu habis! Kata yang benar: "${word}"`, 'wrong', 3200);

    appendChatMessage({
      text: `⏰ [WAKTU HABIS] Tidak ada yang menebak tepat. Kata yang benar adalah: "${word}".`,
      from: 'system',
      ts:   Date.now(),
      self: false,
    });
  } else {
    /* Tebakan salah */
    scoreState.wrong += 1;
    scoreWrongEl.textContent = String(scoreState.wrong);

    if (isMyGuess) {
      showFeedback(`❌ "${guess}" salah! Coba lagi.`, 'wrong', 1800);
      triggerShake();
    }

    appendChatMessage({
      text: `[Tebakan]: ${guess} ❌`,
      from: guesserId,
      ts:   Date.now(),
      self: isMyGuess,
    });
  }
});

/* ============================================================
 * Connection Status & Presence Listeners
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

onMemberChange((count, members) => {
  roomMembersEl.textContent = `👥 ${count} pemain`;

  /* [AUTHORITATIVE - HOST]: Update urutan pemain saat ada perubahan anggota */
  if (state.isHost) {
    const existing = hostState.playerOrder.filter((k) => members.includes(k));
    const brandNew = members.filter((k) => !existing.includes(k));
    hostState.playerOrder = [...existing, ...brandNew];
  }
});

/* ============================================================
 * Enter Room Helper
 * ============================================================ */

/**
 * enterRoom - Masuk room dan inisialisasi Host/Penebak.
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

    state.isHost = isHost;
    roomCodeDisplay.textContent = trimmed;

    /* Tampilkan role badge di status bar */
    if (state.isHost) {
      roleBadge.textContent = '👑 Host';
      roleBadge.className   = 'role-badge role-badge--host';
    } else {
      roleBadge.textContent = '🔍 Pemain';
      roleBadge.className   = 'role-badge role-badge--guesser';
    }

    showGame();

    if (state.isHost) {
      /* [AUTHORITATIVE - HOST]: Host menginisialisasi ronde giliran pertama */
      hostStartNextTurn();
    } else {
      /* Penebak menunggu event 'turn-change' dari Host */
      renderGuesserWordSlots(null);
      canvasWrapper.classList.add('is-guesser');
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
 * Lobby Events
 * ============================================================ */

btnCreateRoom.addEventListener('click', () => {
  const code = generateRoomCode();
  enterRoom(code, true);
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  enterRoom(joinCodeInput.value, false);
});

joinCodeInput.addEventListener('input', () => {
  const sel = joinCodeInput.selectionStart;
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinCodeInput.setSelectionRange(sel, sel);
});

btnLeaveRoom.addEventListener('click', showLobby);

/* ============================================================
 * Canvas Sizing
 * ============================================================ */

function resize() {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = canvas.clientWidth || rect.width;
  if (!cssWidth || cssWidth === 0) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssHeight = Math.round(cssWidth * (9 / 16));

  const tmp  = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  if (canvas.width > 0 && canvas.height > 0) {
    tmp.getContext('2d').drawImage(canvas, 0, 0);
  }

  canvas.style.width  = '100%';
  canvas.style.height = `${cssHeight}px`;

  canvas.width  = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  if (tmp.width > 0 && tmp.height > 0) {
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, canvas.width, canvas.height);
  }
  applyCtxDefaults();
}

function applyCtxDefaults() {
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (canvas.width / rect.width) : 1;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size * scale;
}

/* ============================================================
 * Drawing & Real-time Stroke Batching (Fase 2c)
 * ============================================================ */

function canvasPoint(e) {
  const rect   = canvas.getBoundingClientRect();
  const scaleX = rect.width  > 0 ? (canvas.width  / rect.width)  : 1;
  const scaleY = rect.height > 0 ? (canvas.height / rect.height) : 1;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

function flushStrokeBatch() {
  if (currentBatchPoints.length > 1) {
    const rect = canvas.getBoundingClientRect();
    const sizeRatio = rect.width > 0 ? (state.size / rect.width) : (state.size / canvas.width);
    sendStroke({
      points:    currentBatchPoints,
      color:     state.color,
      sizeRatio,
      isStart:   isBatchStart,
      isEnd:     false,
    });
    isBatchStart = false;
    currentBatchPoints = [currentBatchPoints[currentBatchPoints.length - 1]];
  }
}

function startDraw(e) {
  /* HANYA drawer yang diizinkan menggambar */
  if (!state.isDrawer) return;

  // Hanya proses primary pointer (left click mouse atau touch utama)
  if (e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;

  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_) {}

  showCursor();
  updateCursor(e);

  const { x, y } = canvasPoint(e);
  state.drawing  = true;
  state.lastX    = x;
  state.lastY    = y;

  const rect = canvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (canvas.width / rect.width) : 1;

  ctx.beginPath();
  ctx.arc(x, y, (state.size * scale) / 2, 0, Math.PI * 2);
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

  const rect = canvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (canvas.width / rect.width) : 1;

  ctx.beginPath();
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size * scale;
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

  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }

  clearInterval(batchIntervalId);
  batchIntervalId = null;

  if (currentBatchPoints.length > 0) {
    const rect = canvas.getBoundingClientRect();
    const sizeRatio = rect.width > 0 ? (state.size / rect.width) : (state.size / canvas.width);
    sendStroke({
      points:    currentBatchPoints,
      color:     state.color,
      sizeRatio,
      isStart:   isBatchStart,
      isEnd:     true,
    });
  }
  currentBatchPoints = [];
  isBatchStart = false;
}

/* ============================================================
 * Peer Stroke Rendering (Render goresan dari Drawer aktif)
 * ============================================================ */

let peerDrawingTimeout = null;

function showPeerDrawing(from) {
  drawingIndicator.classList.add('is-peer-drawing');
  drawingIndicator.textContent = `🎨 Peer ${from.slice(0, 4)} sedang menggambar...`;

  clearTimeout(peerDrawingTimeout);
  peerDrawingTimeout = setTimeout(() => {
    drawingIndicator.classList.remove('is-peer-drawing');
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
  drawingIndicator.textContent = `🗑 Canvas dibersihkan oleh Peer ${from.slice(0, 4)}`;
});

/* ============================================================
 * Custom Brush Cursor
 * ============================================================ */

function updateCursor(e) {
  if (!state.isDrawer) return;
  const rect = canvas.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const y    = e.clientY - rect.top;

  brushCursor.style.left   = `${x}px`;
  brushCursor.style.top    = `${y}px`;
  brushCursor.style.width  = `${state.size}px`;
  brushCursor.style.height = `${state.size}px`;
}

function showCursor() {
  if (state.isDrawer) brushCursor.style.display = 'block';
}

function hideCursor() {
  brushCursor.style.display = 'none';
}

function onPointerLeave(e) {
  // Bila pointer sedang ditangkap (drag melewati batas canvas), tetap render
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    return;
  }
  hideCursor();
  if (state.drawing) {
    stopDraw(e);
  }
}

/* ============================================================
 * Toolbar Events
 * ============================================================ */

function setColor(hex) {
  state.color       = hex;
  ctx.strokeStyle   = hex;
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
  state.size = px;
  applyCtxDefaults();

  brushCursor.style.width  = `${px}px`;
  brushCursor.style.height = `${px}px`;

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
  if (!state.isDrawer) return;
  clearCanvas();
  sendClear();
});

/* Canvas event listeners */
canvas.addEventListener('pointerdown',   startDraw,      { passive: false });
canvas.addEventListener('pointermove',   draw,           { passive: false });
canvas.addEventListener('pointermove',   updateCursor,   { passive: true });
canvas.addEventListener('pointerup',     stopDraw,       { passive: false });
canvas.addEventListener('pointercancel', stopDraw,       { passive: false });
canvas.addEventListener('pointerenter',  showCursor,     { passive: true });
canvas.addEventListener('pointerleave',  onPointerLeave, { passive: true });
canvas.addEventListener('lostpointercapture', () => {
  if (state.drawing) {
    state.drawing = false;
    ctx.closePath();
    clearInterval(batchIntervalId);
    batchIntervalId = null;
    currentBatchPoints = [];
    isBatchStart = false;
  }
  hideCursor();
});

/* ============================================================
 * [CLIENT - ACTION] Guess Box Handling
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

guessForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = guessInput.value.trim();
  if (!raw) return;

  guessInput.value = '';

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
}

window.addEventListener('resize', resize);
init();
