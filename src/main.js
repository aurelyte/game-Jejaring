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
  currentRoom,
  joinRoom,
  leaveRoom,
  sendChat,
  sendStroke,
  sendClear,
  sendNewWord,
  sendGuessAttempt,
  sendGuessResult,
  sendTurnChange,
  sendPowerupRequest,
  sendPowerupApplied,
  sendPowerupEnd,
  sendPlayerJoined,
  sendPlayerLeft,
  sendGameStart,
  sendScoreUpdate,
  onStatusChange,
  onMemberChange,
  onMemberPresence,
  onChatMessage,
  onStroke,
  onClear,
  onNewWord,
  onGuessAttempt,
  onGuessResult,
  onTurnChange,
  onPowerupRequest,
  onPowerupApplied,
  onPowerupEnd,
  onPlayerJoined,
  onPlayerLeft,
  onGameStart,
  onScoreUpdate,
  getSelfKey,
  getPlayerName,
  setPlayerName,
  getSavedRoomCode,
  setSavedRoomCode,
  getSavedIsHost,
  setSavedIsHost,
  setPresenceGameStatus,
  getRoomMemberKeys,
  getMemberDetails,
  dbCreateRoom,
  dbJoinRoom,
  dbStartRoom,
  dbGetRoomState,
  dbLeaveRoom,
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

/* State power-up lokal pada client (Fase 4b & 4c) */
const powerupState = {
  usedRevealThisTurn: false,
  usedFreezeThisTurn: false,
  usedTimeThisTurn:   false,
  isFrozen:           false,
};

let localFreezeInterval = null;

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
  currentHint:        null,      // { length: number, slots: string[] }
  usedRevealPlayers:  new Set(), // daftar pemain yang sudah pakai reveal di ronde ini
  usedFreezePlayers:  new Set(), // daftar pemain yang sudah pakai freeze di ronde ini
  usedTimeThisTurn:   false,     // flag powerup tambah waktu untuk drawer
  freezeTimeout:      null,      // timer timeout host untuk durasi beku 5s
  freezeUntil:        0,         // timestamp berakhirnya efek beku
  freezeInitiator:    null,      // ID pemain yang membekukan tebakan lawan
  scores:             {},        // [AUTHORITATIVE - HOST]: { [playerId]: number }
};

/* State skor lokal dan leaderboard yang tersinkronisasi dari Host (Fase 5a) */
const leaderboardState = {
  scores: {}, // { [playerId]: number }
  list:   [], // Array<{ id, name, score, rank, is_drawer, is_host }>
};

/* ============================================================
 * DOM refs
 * ============================================================ */

const lobbyScreen      = /** @type {HTMLElement}       */ (document.getElementById('lobbyScreen'));
const waitingScreen    = /** @type {HTMLElement}       */ (document.getElementById('waitingScreen'));
const gameScreen       = /** @type {HTMLElement}       */ (document.getElementById('gameScreen'));

/* Room bar & Status indicators */
const roomCodeDisplay  = /** @type {HTMLElement}       */ (document.getElementById('roomCodeDisplay'));
const roomMembersEl    = /** @type {HTMLElement}       */ (document.getElementById('roomMembers'));
const connBadgeEl      = /** @type {HTMLElement}       */ (document.getElementById('connBadge'));
const timerBadgeEl     = /** @type {HTMLElement}       */ (document.getElementById('timerBadge'));
const roleBadge        = /** @type {HTMLElement}       */ (document.getElementById('roleBadge'));
const myScoreBadge     = /** @type {HTMLElement}       */ (document.getElementById('myScoreBadge'));
const btnLeaveRoom     = /** @type {HTMLButtonElement}  */ (document.getElementById('btnLeaveRoom'));
const drawingIndicator = /** @type {HTMLElement}       */ (document.getElementById('drawingIndicator'));
const canvasWrapper    = /** @type {HTMLElement}       */ (document.getElementById('canvasWrapper'));

/* Lobby inputs */
const playerNameInput  = /** @type {HTMLInputElement}   */ (document.getElementById('playerNameInput'));
const btnCreateRoom    = /** @type {HTMLButtonElement}  */ (document.getElementById('btnCreateRoom'));
const btnJoinRoom      = /** @type {HTMLButtonElement}  */ (document.getElementById('btnJoinRoom'));
const joinForm         = /** @type {HTMLFormElement}    */ (document.getElementById('joinForm'));
const joinCodeInput    = /** @type {HTMLInputElement}   */ (document.getElementById('joinCodeInput'));
const joinErrorEl      = /** @type {HTMLParagraphElement}*/ (document.getElementById('joinError'));

/* Waiting Room elements */
const waitingRoomCode         = /** @type {HTMLElement}       */ (document.getElementById('waitingRoomCode'));
const btnCopyCode             = /** @type {HTMLButtonElement} */ (document.getElementById('btnCopyCode'));
const waitingPlayerCountBadge = /** @type {HTMLElement}       */ (document.getElementById('waitingPlayerCountBadge'));
const waitingPlayerList       = /** @type {HTMLUListElement}  */ (document.getElementById('waitingPlayerList'));
const hostWaitingControls     = /** @type {HTMLElement}       */ (document.getElementById('hostWaitingControls'));
const btnStartGame            = /** @type {HTMLButtonElement} */ (document.getElementById('btnStartGame'));
const nonHostWaitingNotice    = /** @type {HTMLElement}       */ (document.getElementById('nonHostWaitingNotice'));
const waitingError            = /** @type {HTMLElement}       */ (document.getElementById('waitingError'));
const btnLeaveWaiting         = /** @type {HTMLButtonElement} */ (document.getElementById('btnLeaveWaiting'));

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

/* Power-up elements (Fase 4b & 4c) */
const powerupBar       = /** @type {HTMLElement}       */ (document.getElementById('powerupBar'));
const btnPowerupReveal = /** @type {HTMLButtonElement}  */ (document.getElementById('btnPowerupReveal'));
const btnPowerupFreeze = /** @type {HTMLButtonElement}  */ (document.getElementById('btnPowerupFreeze'));
const btnPowerupTime   = /** @type {HTMLButtonElement}  */ (document.getElementById('btnPowerupTime'));
const freezeOverlay    = /** @type {HTMLElement}       */ (document.getElementById('freezeOverlay'));
const freezeNoticeText = /** @type {HTMLElement}       */ (document.getElementById('freezeNoticeText'));
const freezeTimerBadge = /** @type {HTMLElement}       */ (document.getElementById('freezeTimerBadge'));

/* Chat */
const chatForm         = /** @type {HTMLFormElement}   */ (document.getElementById('chatForm'));
const chatInput        = /** @type {HTMLInputElement}  */ (document.getElementById('chatInput'));
const chatList         = /** @type {HTMLOListElement}  */ (document.getElementById('chatList'));

/* Leaderboard (Fase 5a) */
const leaderboardSection      = /** @type {HTMLElement}       */ (document.getElementById('leaderboardSection'));
const leaderboardList         = /** @type {HTMLOListElement}  */ (document.getElementById('leaderboardList'));
const leaderboardTotalPlayers = /** @type {HTMLElement}       */ (document.getElementById('leaderboardTotalPlayers'));

/* Timer lokal client */
let localTimerInterval = null;
let nextRoundTimer     = null;

/* ============================================================
 * Screen Switching & Waiting Room UI
 * ============================================================ */

function showGame() {
  lobbyScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderLeaderboard();
  requestAnimationFrame(() => {
    resize();
  });
}

function showWaitingRoom(code, isHost) {
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');

  waitingRoomCode.textContent = code;
  waitingError.textContent = '';

  if (isHost) {
    hostWaitingControls.classList.remove('hidden');
    nonHostWaitingNotice.classList.add('hidden');
    roleBadge.textContent = '👑 Host';
    roleBadge.className = 'role-badge role-badge--host';
  } else {
    hostWaitingControls.classList.add('hidden');
    nonHostWaitingNotice.classList.remove('hidden');
    roleBadge.textContent = '🔍 Pemain';
    roleBadge.className = 'role-badge role-badge--guesser';
  }
}

function renderWaitingPlayerList(members) {
  if (!waitingPlayerList) return;

  const list = (Array.isArray(members) && members.length > 0)
    ? members
    : [{ id: getSelfKey(), name: getPlayerName(), is_host: state.isHost, online: true }];

  waitingPlayerCountBadge.textContent = `👥 ${list.length}/8 Pemain`;
  waitingPlayerList.innerHTML = '';

  list.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'waiting-player-item';

    const isSelf = (p.id === getSelfKey());
    const initial = (p.name || 'P').trim().charAt(0).toUpperCase() || 'P';

    li.innerHTML = `
      <div class="waiting-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
      <div class="waiting-player-info">
        <span class="waiting-player-name">${escapeHtml(p.name || 'Pemain')}</span>
        ${p.is_host ? '<span class="badge-host">👑 HOST</span>' : ''}
        ${isSelf ? '<span class="badge-you">(Kamu)</span>' : ''}
      </div>
      <span class="online-dot" title="Online">Online</span>
    `;
    waitingPlayerList.appendChild(li);
  });
}

/* ============================================================
 * [AUTHORITATIVE - HOST] Skor & Perhitungan (Fase 5a)
 * ============================================================ */

/**
 * calculateGuessScore - [HOST AUTHORITATIVE]
 * Hitung perolehan poin: semakin cepat menebak (sisa detik lebih banyak),
 * skor tebakan semakin tinggi (100 - 500 poin). Penggambar juga mendapatkan
 * poin apresiasi 50% dari skor tebakan penebak (50 - 250 poin).
 *
 * @param {number} secondsRemaining
 * @param {number} turnDuration
 * @returns {{ guesserPoints: number, drawerPoints: number, speedBonus: number }}
 */
function calculateGuessScore(secondsRemaining, turnDuration = 60) {
  const basePoints = 100;
  const ratio = Math.max(0, Math.min(1, Number(secondsRemaining) / (turnDuration || 60)));
  const speedBonus = Math.round(ratio * 400); // 0 sampai 400 poin bonus kecepatan
  const guesserPoints = basePoints + speedBonus; // Rentang 100 s.d. 500 poin
  const drawerPoints = Math.round(guesserPoints * 0.5); // Rentang 50 s.d. 250 poin

  return { guesserPoints, drawerPoints, speedBonus };
}

/**
 * buildLeaderboardList - Menyusun dan mengurutkan daftar pemain berdasarkan skor tertinggi.
 *
 * @param {Record<string, number>} [scoresMap]
 * @returns {Array<{ id: string, name: string, score: number, rank: number, is_host: boolean, is_drawer: boolean }>}
 */
function buildLeaderboardList(scoresMap = {}) {
  const members = getMemberDetails();
  const allIds = new Set([
    ...Object.keys(scoresMap || {}),
    ...members.map((m) => m.id),
    getSelfKey(),
  ]);

  const list = Array.from(allIds).map((id) => {
    const mem = members.find((m) => m.id === id);
    const name = mem ? mem.name : (id === getSelfKey() ? getPlayerName() : `Pemain ${id.slice(0, 4)}`);
    const isHost = mem ? mem.is_host : (id === getSelfKey() ? state.isHost : false);
    const isDrawer = (id === state.currentDrawerId);
    const score = Number((scoresMap && scoresMap[id]) || (leaderboardState.scores && leaderboardState.scores[id]) || 0);

    return {
      id,
      name,
      score,
      is_host: isHost,
      is_drawer: isDrawer,
    };
  });

  /* Urutkan skor tertinggi (descending); jika skor sama, urutkan nama */
  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return list.map((item, idx) => ({
    ...item,
    rank: idx + 1,
  }));
}

/**
 * renderLeaderboard - Render UI Leaderboard real-time ke dalam DOM.
 *
 * @param {Array<any>} [leaderboardData]
 */
function renderLeaderboard(leaderboardData) {
  if (!leaderboardList) return;

  const data = (Array.isArray(leaderboardData) && leaderboardData.length > 0)
    ? leaderboardData
    : buildLeaderboardList(leaderboardState.scores);

  leaderboardList.innerHTML = '';

  if (leaderboardTotalPlayers) {
    leaderboardTotalPlayers.textContent = `👥 ${data.length} Pemain`;
  }

  /* Perbarui badge skor sendiri di room bar */
  const myData = data.find((p) => p.id === getSelfKey());
  if (myScoreBadge) {
    myScoreBadge.textContent = `🏆 ${myData ? myData.score : 0} pts`;
  }

  data.forEach((player) => {
    const li = document.createElement('li');
    const isSelf = (player.id === getSelfKey());
    const isDrawer = (player.id === state.currentDrawerId);

    li.className = `leaderboard-item rank-${player.rank} ${isSelf ? 'is-self' : ''} ${isDrawer ? 'is-drawer' : ''}`;
    li.dataset.playerId = player.id;

    let rankDisplay = `#${player.rank}`;
    if (player.rank === 1) rankDisplay = '🥇 1';
    else if (player.rank === 2) rankDisplay = '🥈 2';
    else if (player.rank === 3) rankDisplay = '🥉 3';

    const initial = (player.name || 'P').trim().charAt(0).toUpperCase() || 'P';

    li.innerHTML = `
      <div class="leaderboard-rank">${rankDisplay}</div>
      <div class="leaderboard-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
      <div class="leaderboard-player-info">
        <div class="leaderboard-name-row">
          <span class="leaderboard-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</span>
          ${player.is_host ? '<span class="badge-host">👑 HOST</span>' : ''}
          ${isSelf ? '<span class="badge-you">(Kamu)</span>' : ''}
          ${isDrawer ? '<span class="badge-drawer">🎨 Drawer</span>' : ''}
        </div>
      </div>
      <div class="leaderboard-score-box">
        <span class="leaderboard-score-val">${player.score}</span>
        <span class="leaderboard-score-unit">pts</span>
      </div>
    `;

    leaderboardList.appendChild(li);
  });
}

async function showLobby() {
  await leaveRoom();

  clearInterval(hostState.timerInterval);
  clearInterval(localTimerInterval);
  clearTimeout(nextRoundTimer);
  clearTimeout(hostState.freezeTimeout);
  clearInterval(localFreezeInterval);
  unfreezeUI();

  state.isHost            = false;
  state.isDrawer          = false;
  state.currentDrawerId   = '';
  hostState.secretWord    = '';
  hostState.playerOrder   = [];
  hostState.currentHint   = null;
  hostState.usedRevealPlayers.clear();
  hostState.usedFreezePlayers.clear();
  hostState.usedTimeThisTurn = false;
  hostState.freezeUntil      = 0;
  hostState.freezeInitiator  = null;
  hostState.scores           = {};

  powerupState.usedRevealThisTurn = false;
  powerupState.usedFreezeThisTurn = false;
  powerupState.usedTimeThisTurn   = false;
  powerupState.isFrozen           = false;

  leaderboardState.scores = {};
  leaderboardState.list   = [];
  renderLeaderboard([]);
  if (myScoreBadge) myScoreBadge.textContent = '🏆 0 pts';

  scoreState.correct      = 0;
  scoreState.wrong        = 0;
  scoreCorrectEl.textContent = '0';
  scoreWrongEl.textContent   = '0';

  waitingScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  joinCodeInput.value     = '';
  joinErrorEl.textContent = '';
  waitingError.textContent = '';
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
 * hostStartTurnForDrawer - [HOST AUTHORITATIVE]
 * Mulai ronde giliran untuk penggambar tertentu (drawerId).
 * Digunakan untuk:
 * - Penggambar pertama hasil undian acak (Randomized First Drawer).
 * - Penggambar ronde selanjutnya pada siklus round-robin.
 *
 * @param {string} drawerId
 */
function hostStartTurnForDrawer(drawerId) {
  if (!state.isHost) return;

  clearInterval(hostState.timerInterval);
  clearTimeout(nextRoundTimer);
  clearTimeout(hostState.freezeTimeout);
  hostState.isRoundEnding    = false;
  hostState.freezeUntil      = 0;
  hostState.freezeInitiator  = null;
  hostState.usedTimeThisTurn = false;
  hostState.usedRevealPlayers.clear();
  hostState.usedFreezePlayers.clear();

  const currentDrawerId = drawerId || getSelfKey();

  /* Host memilih kata baru */
  const word = pickWord();
  hostState.secretWord       = word;
  hostState.secondsRemaining = hostState.turnDuration;

  /* Siapkan hint tersensor untuk penebak */
  const cleanLen    = word.replace(/ /g, '').length;
  const maskedSlots = Array.from(word).map((ch) => (ch === ' ' ? ' ' : '_'));
  const hint        = { length: cleanLen, slots: maskedSlots };
  hostState.currentHint = hint;

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
 * hostStartNextTurn - [HOST AUTHORITATIVE]
 * Mulai giliran baru round-robin, tentukan drawer, dan siarkan 'turn-change'.
 */
function hostStartNextTurn() {
  if (!state.isHost) return;

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
  const nextDrawerId           = hostState.playerOrder[hostState.currentDrawerIndex];

  hostStartTurnForDrawer(nextDrawerId);
}

/**
 * hostHandleTurnTimeout - [HOST AUTHORITATIVE]
 * Dipanggil saat timer 60s habis. Mengumumkan kata asli dan ganti giliran.
 */
function hostHandleTurnTimeout() {
  if (!state.isHost || hostState.isRoundEnding) return;
  hostState.isRoundEnding = true;
  clearTimeout(hostState.freezeTimeout);
  hostState.freezeUntil     = 0;
  hostState.freezeInitiator = null;

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
 * [AUTHORITATIVE - HOST ONLY] Validasi Tebakan & Hitung Skor (Fase 3b & 5a)
 * ============================================================ */

onGuessAttempt(async ({ guess, from }) => {
  if (!state.isHost || hostState.isRoundEnding) return;
  if (!hostState.secretWord) return;

  /* [FASE 4c]: Tolak tebakan dari pemain yang sedang terkena status beku */
  if (Date.now() < hostState.freezeUntil && from !== hostState.freezeInitiator) {
    return;
  }

  const cleanedGuess  = guess.trim().toLowerCase();
  const cleanedAnswer = hostState.secretWord.trim().toLowerCase();
  const isCorrect     = (cleanedGuess === cleanedAnswer);

  if (isCorrect) {
    /* [FASE 5a]: Host hitung skor secara otoritatif */
    const { guesserPoints, drawerPoints, speedBonus } = calculateGuessScore(
      hostState.secondsRemaining,
      hostState.turnDuration
    );

    /* Perbarui skor penebak */
    hostState.scores[from] = (hostState.scores[from] || 0) + guesserPoints;

    /* Perbarui skor penggambar (drawer) jika bukan orang yang sama */
    const currentDrawerId = hostState.playerOrder[hostState.currentDrawerIndex];
    if (currentDrawerId && currentDrawerId !== from) {
      hostState.scores[currentDrawerId] = (hostState.scores[currentDrawerId] || 0) + drawerPoints;
    }

    /* Ambil nama pemain untuk metadata */
    const members     = getMemberDetails();
    const guesserMem  = members.find((m) => m.id === from);
    const guesserName = guesserMem ? guesserMem.name : (from === getSelfKey() ? getPlayerName() : `Pemain ${from.slice(0, 4)}`);
    const drawerMem   = members.find((m) => m.id === currentDrawerId);
    const drawerName  = drawerMem ? drawerMem.name : (currentDrawerId === getSelfKey() ? getPlayerName() : `Pemain ${currentDrawerId ? currentDrawerId.slice(0, 4) : 'Host'}`);

    /* Siarkan hasil evaluasi ke seluruh client di room */
    await sendGuessResult({
      isCorrect:        true,
      guesserId:        from,
      guess,
      word:             hostState.secretWord,
      pointsAwarded:    guesserPoints,
      drawerPoints:     (currentDrawerId && currentDrawerId !== from) ? drawerPoints : 0,
      drawerId:         currentDrawerId,
      secondsRemaining: hostState.secondsRemaining,
    });

    /* Siarkan skor & leaderboard terkini ke seluruh client */
    const updatedLeaderboard = buildLeaderboardList(hostState.scores);
    await sendScoreUpdate({
      scores:      hostState.scores,
      leaderboard: updatedLeaderboard,
      lastAward: {
        guesserId:        from,
        guesserName,
        guesserPoints,
        drawerId:         currentDrawerId,
        drawerName,
        drawerPoints:     (currentDrawerId && currentDrawerId !== from) ? drawerPoints : 0,
        speedBonus,
        secondsRemaining: hostState.secondsRemaining,
      },
    });

    /* Akhiri ronde dan jadwalkan ronde berikutnya */
    hostState.isRoundEnding = true;
    clearInterval(hostState.timerInterval);
    clearTimeout(hostState.freezeTimeout);
    hostState.freezeUntil     = 0;
    hostState.freezeInitiator = null;

    clearTimeout(nextRoundTimer);
    nextRoundTimer = setTimeout(() => {
      if (state.isHost) {
        hostStartNextTurn();
      }
    }, 3500);
  } else {
    /* Tebakan salah */
    await sendGuessResult({
      isCorrect:     false,
      guesserId:     from,
      guess,
      word:          null,
      pointsAwarded: 0,
    });
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

function applyFreeze(initiatorId, duration) {
  powerupState.isFrozen = true;
  guessForm.classList.add('is-frozen');
  guessInput.disabled = true;
  guessInput.placeholder = '🧊 Tebakan dibekukan...';
  freezeOverlay.classList.remove('hidden');
  freezeNoticeText.textContent = `Tebakan Anda sedang dibekukan oleh Peer ${initiatorId.slice(0, 4)}!`;

  freezeTimerBadge.textContent = `${duration}s`;
  let secRemaining = duration;
  clearInterval(localFreezeInterval);
  localFreezeInterval = setInterval(() => {
    secRemaining -= 1;
    if (secRemaining > 0) {
      freezeTimerBadge.textContent = `${secRemaining}s`;
    } else {
      clearInterval(localFreezeInterval);
    }
  }, 1000);
}

function unfreezeUI() {
  powerupState.isFrozen = false;
  clearInterval(localFreezeInterval);
  guessForm.classList.remove('is-frozen');
  freezeOverlay.classList.add('hidden');
  if (!state.isDrawer) {
    guessInput.disabled = false;
    guessInput.placeholder = 'Ketik tebakanmu…';
  }
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
    if (ch === ' ') {
      slot.className = 'letter-slot space-gap';
    } else if (ch !== '_') {
      slot.className   = 'letter-slot revealed';
      slot.textContent = ch.toUpperCase();
    } else {
      slot.className = 'letter-slot';
    }
    wordSlotsEl.appendChild(slot);
  }

  const unrevealed = hint.slots.filter(ch => ch === '_').length;
  wordHintEl.textContent = `(${hint.length} huruf${unrevealed < hint.length ? `, ${hint.length - unrevealed} terbuka` : ''})`;
}

/* Event listener 'turn-change' dari Host */
onTurnChange(({ drawerId, drawerWord, hint, duration, startedAt }) => {
  clearCanvas();
  startLocalTimer(duration, startedAt);

  state.currentDrawerId = drawerId;
  const isMeDrawer      = (drawerId === getSelfKey());
  state.isDrawer        = isMeDrawer;

  /* Reset status power-up lokal pada giliran baru */
  powerupState.usedRevealThisTurn = false;
  powerupState.usedFreezeThisTurn = false;
  powerupState.usedTimeThisTurn   = false;
  unfreezeUI();

  if (isMeDrawer) {
    /* [DRAWER]: Canvas aktif untuk menggambar, toolbar terbuka */
    canvasWrapper.classList.remove('is-guesser');
    hostGuessNotice.classList.remove('hidden');
    hostGuessNotice.textContent = '🎨 Anda sedang menggambar! Biarkan pemain lain menebak.';
    guessForm.classList.add('hidden');

    /* Tampilkan tombol power-up drawer (Waktu Ekstra), sembunyikan powerup penebak */
    btnPowerupReveal.classList.add('hidden');
    btnPowerupFreeze.classList.add('hidden');
    btnPowerupTime.classList.remove('hidden');
    btnPowerupTime.disabled = false;

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

    /* Tampilkan tombol power-up penebak (Intip Huruf & Bekukan Lawan) */
    btnPowerupReveal.classList.remove('hidden');
    btnPowerupReveal.disabled = false;
    btnPowerupFreeze.classList.remove('hidden');
    btnPowerupFreeze.disabled = false;
    btnPowerupTime.classList.add('hidden');

    /* Tampilkan slot tersensor */
    renderGuesserWordSlots(hint);

    const drawerLabel = (drawerId === getSelfKey() ? 'Kamu' : `Peer ${drawerId.slice(0, 4)}`);
    drawingIndicator.textContent = `🔍 ${drawerLabel} sedang menggambar. Perhatikan canvas dan tebak di bawah!`;
    drawingIndicator.className   = 'drawing-indicator';

    showFeedback(`🎨 Giliran ${drawerLabel} menggambar!`, 'correct', 2500);
  }

  /* Perbarui badge drawer di papan skor */
  renderLeaderboard();

  /* Tombol ganti giliran manual hanya tampil pada Host */
  if (state.isHost) {
    btnHostNextWord.classList.remove('hidden');
  } else {
    btnHostNextWord.classList.add('hidden');
  }
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Update UI Berdasarkan 'guess-result' & Skor (Fase 3b & 5a)
 * ============================================================ */

onGuessResult(({ isCorrect, guesserId, guess, word, pointsAwarded, drawerPoints, drawerId, secondsRemaining }) => {
  const isMyGuess   = (guesserId === getSelfKey());
  const guesserName = isMyGuess ? 'Kamu' : `Peer ${guesserId.slice(0, 4)}`;

  /* Hentikan countdown timer lokal jika ronde berakhir */
  if (isCorrect || guesserId === 'timeout') {
    clearInterval(localTimerInterval);
    updateTimerDisplay(0);
    unfreezeUI();

    if (state.isHost) {
      clearTimeout(hostState.freezeTimeout);
      hostState.freezeUntil     = 0;
      hostState.freezeInitiator = null;
    }
  }

  if (isCorrect) {
    /* Update statistik ronde */
    scoreState.correct += 1;
    scoreCorrectEl.textContent = String(scoreState.correct);

    const ptsInfo   = pointsAwarded ? ` (+${pointsAwarded} pts)` : '';
    const speedInfo = (typeof secondsRemaining === 'number') ? ` [${secondsRemaining}s sisa]` : '';

    /* Buka kata rahasia di layar semua pemain */
    wordLabelEl.textContent = 'Kata tertebak:';
    wordSlotsEl.innerHTML   = `<span class="secret-word-revealed">${escapeHtml(word)}</span>`;
    wordHintEl.textContent  = `(Ditebak oleh ${guesserName}${ptsInfo}! Giliran berikutnya segera dimulai...)`;

    /* Feedback visual */
    if (isMyGuess) {
      showFeedback(`🎉 BENAR${ptsInfo}! Tebakanmu tepat: "${word}"${speedInfo}`, 'correct', 3200);
    } else {
      showFeedback(`🎉 ${guesserName}${ptsInfo} berhasil menebak: "${word}"!`, 'correct', 3200);
    }

    /* Notifikasi chat */
    let chatText = `🏆 [TEBAKAN BENAR] ${guesserName}${ptsInfo} berhasil menebak: "${word}"!`;
    if (drawerPoints && drawerId) {
      const isDrawerMe = (drawerId === getSelfKey());
      const dLabel = isDrawerMe ? 'Kamu (Drawer)' : `Drawer`;
      chatText += ` · ${dLabel} +${drawerPoints} pts!`;
    }

    appendChatMessage({
      text: chatText,
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
 * [CLIENT - RENDER ONLY] Leaderboard & Skor Update (Fase 5a)
 * ============================================================ */

onScoreUpdate(({ scores, leaderboard, lastAward }) => {
  leaderboardState.scores = scores || {};
  leaderboardState.list   = leaderboard || [];

  renderLeaderboard(leaderboard);

  if (lastAward && leaderboardList) {
    /* Animasi visual (score-bump) pada item pemain yang mendapat skor baru */
    if (lastAward.guesserId) {
      const guesserEl = leaderboardList.querySelector(`[data-player-id="${lastAward.guesserId}"]`);
      if (guesserEl) {
        guesserEl.classList.remove('score-bump');
        void guesserEl.offsetWidth;
        guesserEl.classList.add('score-bump');
      }
    }

    if (lastAward.drawerId) {
      const drawerEl = leaderboardList.querySelector(`[data-player-id="${lastAward.drawerId}"]`);
      if (drawerEl) {
        drawerEl.classList.remove('score-bump');
        void drawerEl.offsetWidth;
        drawerEl.classList.add('score-bump');
      }
    }
  }
});

/* ============================================================
 * [AUTHORITATIVE - HOST ONLY] Penanganan Permintaan Power-up (Fase 4b & 4c)
 * ============================================================ */

onPowerupRequest(async ({ powerup, from }) => {
  if (!state.isHost || hostState.isRoundEnding) return;

  const currentDrawerId = hostState.playerOrder[hostState.currentDrawerIndex];
  const isFromDrawer    = (from === currentDrawerId);

  if (powerup === 'reveal-letter') {
    /* [FASE 4b]: Intip Huruf — Hanya untuk penebak, limit 1x per ronde */
    if (isFromDrawer) return;
    if (hostState.usedRevealPlayers.has(from)) return;
    if (!hostState.currentHint || !hostState.currentHint.slots) return;

    /* Cari indeks slot yang masih tertutup ('_') */
    const unrevealed = [];
    hostState.currentHint.slots.forEach((ch, idx) => {
      if (ch === '_') unrevealed.push(idx);
    });

    if (unrevealed.length === 0) return;

    /* Pilih acak 1 huruf untuk dibuka */
    const pickIdx = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    hostState.currentHint.slots[pickIdx] = hostState.secretWord[pickIdx];
    hostState.usedRevealPlayers.add(from);

    await sendPowerupApplied({
      powerup: 'reveal-letter',
      hint:    hostState.currentHint,
      from,
    });
  } else if (powerup === 'freeze-rivals') {
    /* [FASE 4c]: Bekukan Lawan — Hanya untuk penebak, durasi 5 detik */
    if (isFromDrawer) return;
    if (hostState.usedFreezePlayers.has(from)) return;
    if (Date.now() < hostState.freezeUntil) return;

    hostState.usedFreezePlayers.add(from);
    hostState.freezeUntil     = Date.now() + 5000;
    hostState.freezeInitiator = from;

    await sendPowerupApplied({
      powerup:     'freeze-rivals',
      initiatorId: from,
      duration:    5,
      from,
    });

    /* Host melacak durasi efek secara authoritative */
    clearTimeout(hostState.freezeTimeout);
    hostState.freezeTimeout = setTimeout(async () => {
      if (state.isHost && hostState.freezeUntil > 0) {
        hostState.freezeUntil     = 0;
        hostState.freezeInitiator = null;
        await sendPowerupEnd({ powerup: 'freeze-rivals', from: getSelfKey() });
      }
    }, 5000);
  } else if (powerup === 'extra-time') {
    /* Pelengkap Drawer: Waktu Ekstra +15s */
    if (!isFromDrawer) return;
    if (hostState.usedTimeThisTurn) return;

    hostState.usedTimeThisTurn = true;
    hostState.secondsRemaining = Math.min(60, hostState.secondsRemaining + 15);

    await sendPowerupApplied({
      powerup:  'extra-time',
      duration: hostState.secondsRemaining,
      from,
    });
  }
});

/* ============================================================
 * [CLIENT - RENDER ONLY] Eksekusi Efek Power-up (Fase 4b & 4c)
 * ============================================================ */

onPowerupApplied(({ powerup, hint, initiatorId, duration, from, self }) => {
  if (powerup === 'reveal-letter') {
    /* Update tampilan slot kata untuk semua penebak */
    if (!state.isDrawer) {
      renderGuesserWordSlots(hint);
    }

    if (self) {
      powerupState.usedRevealThisTurn = true;
      btnPowerupReveal.disabled = true;
      showFeedback('💡 Anda membuka 1 huruf bantuan!', 'correct', 2500);
    } else {
      showFeedback(`💡 Peer ${from.slice(0, 4)} membuka 1 huruf bantuan!`, 'correct', 2000);
    }

    appendChatMessage({
      text: `💡 [POWER-UP] ${self ? 'Kamu' : `Peer ${from.slice(0, 4)}`} membuka 1 huruf bantuan!`,
      from: 'system',
      ts:   Date.now(),
      self,
    });
  } else if (powerup === 'freeze-rivals') {
    const isMeInitiator = (initiatorId === getSelfKey());

    if (isMeInitiator) {
      powerupState.usedFreezeThisTurn = true;
      btnPowerupFreeze.disabled = true;
      showFeedback('🧊 Anda membekukan lawan selama 5 detik! Ayo tebak!', 'correct', 3000);
    } else if (!state.isDrawer) {
      /* Penebak lawan terkena efek beku */
      applyFreeze(initiatorId, duration || 5);
    }

    const name = isMeInitiator ? 'Kamu' : `Peer ${initiatorId.slice(0, 4)}`;
    appendChatMessage({
      text: `🧊 [POWER-UP] ${name} membekukan tebakan semua lawan selama ${duration || 5}s!`,
      from: 'system',
      ts:   Date.now(),
      self: isMeInitiator,
    });
  } else if (powerup === 'extra-time') {
    startLocalTimer(duration, Date.now());
    showFeedback('⏰ Waktu giliran ditambah +15 detik!', 'correct', 2500);

    if (self) {
      powerupState.usedTimeThisTurn = true;
      btnPowerupTime.disabled = true;
    }

    const name = self ? 'Kamu' : `Peer ${from.slice(0, 4)}`;
    appendChatMessage({
      text: `⏰ [POWER-UP] ${name} menambahkan +15 detik ke waktu giliran!`,
      from: 'system',
      ts:   Date.now(),
      self,
    });
  }
});

onPowerupEnd(({ powerup }) => {
  if (powerup === 'freeze-rivals') {
    unfreezeUI();
    showFeedback('❄ Efek beku telah selesai!', 'correct', 1500);
  }
});

/* Tombol power-up listeners */
btnPowerupReveal.addEventListener('click', () => {
  if (state.isDrawer || powerupState.usedRevealThisTurn || powerupState.isFrozen) return;
  btnPowerupReveal.disabled = true;
  sendPowerupRequest('reveal-letter');
});

btnPowerupFreeze.addEventListener('click', () => {
  if (state.isDrawer || powerupState.usedFreezeThisTurn || powerupState.isFrozen) return;
  btnPowerupFreeze.disabled = true;
  sendPowerupRequest('freeze-rivals');
});

btnPowerupTime.addEventListener('click', () => {
  if (!state.isDrawer || powerupState.usedTimeThisTurn) return;
  btnPowerupTime.disabled = true;
  sendPowerupRequest('extra-time');
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
 * Waiting Room & Presence Listeners
 * ============================================================ */

onMemberPresence((members) => {
  renderWaitingPlayerList(members);
  if (gameScreen && !gameScreen.classList.contains('hidden')) {
    renderLeaderboard();
  }
});

onPlayerJoined(({ player, from, self }) => {
  if (self) return;
  appendChatMessage({
    text: `👋 ${player?.name || `Peer ${from.slice(0, 4)}`} bergabung ke room.`,
    from: 'system',
    ts:   Date.now(),
    self: false,
  });
});

onPlayerLeft(({ playerId, from, self }) => {
  if (self) return;
  appendChatMessage({
    text: `🚪 Pemain ${playerId.slice(0, 4)} keluar dari room.`,
    from: 'system',
    ts:   Date.now(),
    self: false,
  });
});

/* ============================================================
 * [TRANSITION] Game Start Listener (Waiting Room -> Game)
 * ============================================================ */

onGameStart(({ roomCode, players, firstDrawerId, startedAt }) => {
  roomCodeDisplay.textContent = roomCode;
  showGame();

  state.currentDrawerId = firstDrawerId;
  const isMeDrawer      = (firstDrawerId === getSelfKey());
  state.isDrawer        = isMeDrawer;

  if (state.isHost) {
    /* Inisialisasi skor awal seluruh pemain menjadi 0 pada Host */
    hostState.scores = {};
    if (Array.isArray(players)) {
      players.forEach((p) => {
        const pid = p.player_id || p.id;
        if (pid) hostState.scores[pid] = 0;
      });
    }

    /* Siapkan urutan pemain untuk round-robin berikutnya */
    let playerIds = [];
    if (Array.isArray(players) && players.length > 0) {
      playerIds = players.map((p) => p.player_id || p.id).filter(Boolean);
    }
    if (playerIds.length === 0) {
      playerIds = getRoomMemberKeys();
    }
    if (!playerIds.includes(firstDrawerId)) {
      playerIds.unshift(firstDrawerId);
    }
    if (playerIds.length === 0) {
      playerIds = [getSelfKey()];
    }

    hostState.playerOrder        = playerIds;
    hostState.currentDrawerIndex = hostState.playerOrder.indexOf(firstDrawerId);
    if (hostState.currentDrawerIndex === -1) {
      hostState.currentDrawerIndex = 0;
    }

    /* Siarkan papan skor awal ke seluruh client */
    const initialLeaderboard = buildLeaderboardList(hostState.scores);
    sendScoreUpdate({
      scores:      hostState.scores,
      leaderboard: initialLeaderboard,
      lastAward:   null,
    }).catch(console.error);

    /* Host memulai ronde pertama dengan drawer yang terpilih secara acak */
    hostStartTurnForDrawer(firstDrawerId);
  } else {
    /* Penebak menunggu event 'turn-change' dari Host */
    renderGuesserWordSlots(null);
    canvasWrapper.classList.add('is-guesser');
    renderLeaderboard();
  }
});

/* ============================================================
 * Lobby & Waiting Room Actions
 * ============================================================ */

/* Buat Room Baru */
btnCreateRoom.addEventListener('click', async () => {
  const name = playerNameInput.value.trim() || getPlayerName();
  setPlayerName(name);
  playerNameInput.value = name;

  const code = generateRoomCode();

  btnCreateRoom.disabled    = true;
  btnCreateRoom.textContent = '✦ Menyiapkan…';
  joinErrorEl.textContent   = '';

  try {
    const res = await dbCreateRoom(code, getSelfKey(), name);
    if (res && res.success === false && !res.localOnly) {
      joinErrorEl.textContent = res.message || res.error || 'Gagal membuat room di server.';
      return;
    }

    await joinRoom(code, { name, isHost: true });
    state.isHost = true;
    roomCodeDisplay.textContent = code;

    showWaitingRoom(code, true);
    renderWaitingPlayerList([{ id: getSelfKey(), name, is_host: true, online: true }]);
  } catch (err) {
    try {
      await joinRoom(code, { name, isHost: true });
      state.isHost = true;
      roomCodeDisplay.textContent = code;
      showWaitingRoom(code, true);
      renderWaitingPlayerList([{ id: getSelfKey(), name, is_host: true, online: true }]);
    } catch (innerErr) {
      joinErrorEl.textContent = `Gagal membuat room: ${innerErr.message || err.message}`;
      console.error('[btnCreateRoom error]', innerErr);
    }
  } finally {
    btnCreateRoom.disabled    = false;
    btnCreateRoom.textContent = '✦ Buat Room';
  }
});

/* Masuk Room */
joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const code = joinCodeInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    joinErrorEl.textContent = 'Kode harus 6 karakter (huruf/angka).';
    joinCodeInput.classList.add('error');
    return;
  }

  joinErrorEl.textContent = '';
  joinCodeInput.classList.remove('error');

  const name = playerNameInput.value.trim() || getPlayerName();
  setPlayerName(name);
  playerNameInput.value = name;

  if (btnJoinRoom) {
    btnJoinRoom.disabled    = true;
    btnJoinRoom.textContent = '…';
  }

  try {
    const res = await dbJoinRoom(code, getSelfKey(), name);

    if (res && res.success === false && !res.localOnly) {
      if (res.error === 'GAME_ALREADY_STARTED') {
        joinErrorEl.textContent = 'Game already started. You cannot join this room.';
      } else {
        joinErrorEl.textContent = res.message || res.error || 'Gagal masuk ke room.';
      }
      return;
    }

    const roomStatus         = res?.status || 'waiting';
    const isReconnectingHost = Boolean(res?.is_host);

    await joinRoom(code, { name, isHost: isReconnectingHost });
    state.isHost = isReconnectingHost;
    roomCodeDisplay.textContent = code;

    /* Cek apakah room sudah dimulai (via database atau presence metadata) */
    const hostMember = getMemberDetails().find((m) => m.is_host);
    const isRoomStarted = (roomStatus === 'started') || (hostMember && hostMember.game_status === 'started');

    if (isRoomStarted && !isReconnectingHost) {
      const savedCode = getSavedRoomCode();
      if (savedCode !== code) {
        await leaveRoom();
        joinErrorEl.textContent = 'Game already started. You cannot join this room.';
        return;
      }
    }

    if (isRoomStarted) {
      /* Reconnecting player masuk langsung ke permainan aktif */
      showGame();
      renderGuesserWordSlots(null);
      canvasWrapper.classList.add('is-guesser');
    } else {
      /* Masuk ke Waiting Room */
      showWaitingRoom(code, isReconnectingHost);
      await sendPlayerJoined({ id: getSelfKey(), name, is_host: isReconnectingHost });
    }
  } catch (err) {
    joinErrorEl.textContent = `Gagal masuk: ${err.message}`;
    console.error('[joinForm error]', err);
  } finally {
    if (btnJoinRoom) {
      btnJoinRoom.disabled    = false;
      btnJoinRoom.textContent = 'Masuk →';
    }
  }
});

/* Input sanitizer kode room */
joinCodeInput.addEventListener('input', () => {
  const sel = joinCodeInput.selectionStart;
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinCodeInput.setSelectionRange(sel, sel);
});

/* Tombol Salin Kode Room */
btnCopyCode.addEventListener('click', async () => {
  const code = waitingRoomCode.textContent.trim();
  if (!code || code === '—') return;

  try {
    await navigator.clipboard.writeText(code);
  } catch (_) {
    const input = document.createElement('input');
    input.value = code;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }

  const orig = btnCopyCode.textContent;
  btnCopyCode.textContent = '✓ Tersalin!';
  btnCopyCode.classList.add('copied');
  setTimeout(() => {
    btnCopyCode.textContent = orig;
    btnCopyCode.classList.remove('copied');
  }, 1800);
});

/* Tombol Start Game (Khusus Host) — Menjalankan Undian Acak First Drawer */
btnStartGame.addEventListener('click', async () => {
  if (!state.isHost) return;

  btnStartGame.disabled    = true;
  btnStartGame.textContent = '🚀 Memulai Permainan…';
  waitingError.textContent = '';

  const code    = currentRoom() || waitingRoomCode.textContent.trim();
  const selfKey = getSelfKey();

  let firstDrawerId = null;
  let finalPlayers  = [];

  /* Panggil RPC database dengan lock row SELECT ... FOR UPDATE */
  const res = await dbStartRoom(code, selfKey, 1);

  if (res && res.success && res.first_drawer_id) {
    firstDrawerId = res.first_drawer_id;
    finalPlayers  = res.players || getMemberDetails();
  } else {
    /* Fallback in-memory jika schema database belum di-apply di Supabase SQL Editor */
    console.warn('[Start Game] RPC fallback to in-memory randomized selection:', res?.error);
    const presenceMembers = getMemberDetails();
    const candidateList   = presenceMembers.length > 0
      ? presenceMembers
      : [{ id: selfKey, name: getPlayerName(), is_host: true }];

    const randomPick = candidateList[Math.floor(Math.random() * candidateList.length)];
    firstDrawerId = randomPick.id;
    finalPlayers  = candidateList;
  }

  try {
    /* Tandai status game 'started' di presence channel */
    await setPresenceGameStatus('started');

    /* Broadcast event 'game-start' ke seluruh anggota di room */
    await sendGameStart({
      roomCode:      code,
      players:       finalPlayers,
      firstDrawerId,
      startedAt:     Date.now(),
    });
  } catch (err) {
    console.error('[sendGameStart error]', err);
    waitingError.textContent = `Gagal memulai game: ${err.message}`;
    btnStartGame.disabled    = false;
    btnStartGame.textContent = '🚀 Mulai Permainan';
  }
});

btnLeaveWaiting.addEventListener('click', showLobby);
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
  if (e && e.cancelable) e.preventDefault();
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

  /* Jaga agar kursor tetap tampil jika mouse masih berada di area canvas */
  if (e && e.pointerType === 'touch') {
    hideCursor();
  } else if (e && typeof e.clientX === 'number') {
    const rect = canvas.getBoundingClientRect();
    const isInside = (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );
    if (isInside && state.isDrawer) {
      showCursor();
      updateCursor(e);
    } else {
      hideCursor();
    }
  }
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
  if (!state.isDrawer) {
    hideCursor();
    return;
  }

  /* Pastikan kursor selalu terlihat saat pointer bergerak di canvas */
  brushCursor.style.display = 'block';

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
  // Tidak memanggil hideCursor di sini agar kursor tidak hilang setelah selesai membuat goresan
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
  if (powerupState.isFrozen) {
    showFeedback('🧊 Anda sedang dibekukan! Tunggu efek beku berakhir.', 'wrong', 1600);
    triggerShake();
    return;
  }

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
 * Init & Reconnection
 * ============================================================ */

async function init() {
  resize();
  applyCtxDefaults();

  const currentName = getPlayerName();
  if (playerNameInput) {
    playerNameInput.value = currentName;
    playerNameInput.addEventListener('input', () => {
      setPlayerName(playerNameInput.value);
    });
  }

  /* Cek apakah ada sesi room aktif untuk reconnect otomatis */
  const savedRoom = getSavedRoomCode();
  if (savedRoom) {
    const savedIsHost = getSavedIsHost();
    try {
      const roomState = await dbGetRoomState(savedRoom);
      if (roomState && roomState.success && roomState.room) {
        const r = roomState.room;
        if (r.status === 'waiting') {
          await joinRoom(savedRoom, { name: currentName, isHost: savedIsHost });
          state.isHost = savedIsHost;
          roomCodeDisplay.textContent = savedRoom;
          showWaitingRoom(savedRoom, savedIsHost);
        } else if (r.status === 'started') {
          await joinRoom(savedRoom, { name: currentName, isHost: savedIsHost });
          state.isHost = savedIsHost;
          roomCodeDisplay.textContent = savedRoom;
          showGame();
          renderGuesserWordSlots(null);
          canvasWrapper.classList.add('is-guesser');
        }
      }
    } catch (_) {
      /* Abaikan jika reconnect gagal, pengguna tetap di Lobby */
    }
  }
}

window.addEventListener('resize', resize);
init();
