/**
 * src/main.js — Tebak Gambar
 *
 * Fase 1b: canvas gambar lokal, 100% client-side.
 * Fase 1c: guess box lokal — tebak kata hardcoded, belum multiplayer.
 * Fase 2a: Supabase Realtime room — lobby, join/create, status koneksi.
 * Fase 2b: broadcast 'chat' — uji dua-arah sebelum stroke gambar.
 * Native Canvas API, tanpa library eksternal.
 *
 * Fitur:
 *   - Lobby: buat room (kode acak) atau join dengan kode
 *   - Room bar: kode room, jumlah pemain, badge koneksi, tombol leave
 *   - Drawing dengan mouse/touch via Pointer Events API
 *   - Pilihan warna (swatch + color picker)
 *   - Pilihan ukuran kuas (S / M / L)
 *   - Tombol clear canvas
 *   - Custom brush cursor (ukuran & warna mengikuti pilihan)
 *   - Canvas auto-resize mengikuti lebar wrapper (16:9)
 *   - Guess box: input tebakan, feedback benar/salah, skor lokal
 *   - Kata dipilih random dari array; baru digenerate setelah benar
 */

import {
  generateRoomCode,
  joinRoom,
  leaveRoom,
  sendChat,
  onStatusChange,
  onMemberChange,
  onChatMessage,
} from './room.js';

/* ============================================================
 * Screen switching
 * ============================================================ */

const lobbyScreen = /** @type {HTMLElement} */ (document.getElementById('lobbyScreen'));
const gameScreen  = /** @type {HTMLElement} */ (document.getElementById('gameScreen'));

/**
 * showGame - Hide lobby, reveal game screen, then initialise canvas.
 *
 * Canvas sizing (resize()) must run after the wrapper is visible so
 * offsetWidth returns the real layout width.
 */
function showGame() {
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  /* canvas was invisible during lobby; force a fresh size calculation */
  resize();
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
 * Room bar DOM refs
 * ============================================================ */
const roomCodeDisplay = /** @type {HTMLElement}      */ (document.getElementById('roomCodeDisplay'));
const roomMembersEl   = /** @type {HTMLElement}      */ (document.getElementById('roomMembers'));
const connBadgeEl     = /** @type {HTMLElement}      */ (document.getElementById('connBadge'));
const btnLeaveRoom    = /** @type {HTMLButtonElement} */ (document.getElementById('btnLeaveRoom'));

/* ============================================================
 * Lobby DOM refs
 * ============================================================ */
const btnCreateRoom  = /** @type {HTMLButtonElement} */ (document.getElementById('btnCreateRoom'));
const joinForm       = /** @type {HTMLFormElement}   */ (document.getElementById('joinForm'));
const joinCodeInput  = /** @type {HTMLInputElement}  */ (document.getElementById('joinCodeInput'));
const joinErrorEl    = /** @type {HTMLParagraphElement} */ (document.getElementById('joinError'));

/* ============================================================
 * Connection status → room bar badge
 * ============================================================ */

/** CONN_LABEL - Human-readable labels for each connection status. */
const CONN_LABEL = {
  connecting:   '⬤ Menghubungkan…',
  connected:    '⬤ Terhubung',
  disconnected: '⬤ Terputus',
  error:        '⬤ Error',
};

onStatusChange((status) => {
  connBadgeEl.dataset.status  = status;
  connBadgeEl.textContent     = CONN_LABEL[status] ?? status;
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
 * Shows an inline error on the lobby form when the room code is invalid
 * or connection fails; otherwise wires up the room bar and shows the game.
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

  try {
    await joinRoom(trimmed);
    roomCodeDisplay.textContent = trimmed;
    showGame();
    nextWord();
  } catch (err) {
    joinErrorEl.textContent = `Gagal terhubung: ${err.message}`;
  } finally {
    btnCreateRoom.disabled = false;
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
  const sel   = joinCodeInput.selectionStart;
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinCodeInput.setSelectionRange(sel, sel);
});

btnLeaveRoom.addEventListener('click', showLobby);

/* ============================================================
 * State
 * ============================================================ */

/** @type {{ color: string, size: number, drawing: boolean, lastX: number, lastY: number }} */
const state = {
  color: '#f1f5f9',
  size: 12,
  drawing: false,
  lastX: 0,
  lastY: 0,
};

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

/**
 * resize - Adjust canvas pixel dimensions to match CSS layout.
 *
 * Canvas backing store must match the displayed CSS size to avoid
 * blurry lines.  We preserve existing pixel content by blitting to
 * a temporary canvas before resizing, then restoring.
 */
function resize() {
  /* snapshot current content */
  const tmp    = document.createElement('canvas');
  tmp.width    = canvas.width;
  tmp.height   = canvas.height;
  tmp.getContext('2d').drawImage(canvas, 0, 0);

  /* recalculate pixel size from CSS layout */
  const w = canvas.offsetWidth;
  const h = Math.round(w * (9 / 16));

  canvas.width  = w;
  canvas.height = h;
  canvas.style.height = `${h}px`;

  /* restore content and reset context state (lost on resize) */
  ctx.drawImage(tmp, 0, 0);
  applyCtxDefaults();
}

/** applyCtxDefaults - Set context rendering defaults after resize. */
function applyCtxDefaults() {
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size;
}

/* ============================================================
 * Drawing
 * ============================================================ */

/**
 * canvasPoint - Convert a pointer event into canvas-local coordinates.
 *
 * @param {PointerEvent} e
 * @returns {{ x: number, y: number }}
 */
function canvasPoint(e) {
  const rect  = canvas.getBoundingClientRect();
  /* scale from CSS pixels to canvas pixels */
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

/**
 * startDraw - Begin a new stroke on pointerdown.
 *
 * We call moveTo so the first pointermove draws from the click point
 * rather than from wherever the path was left previously.
 *
 * @param {PointerEvent} e
 */
function startDraw(e) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const { x, y } = canvasPoint(e);
  state.drawing = true;
  state.lastX   = x;
  state.lastY   = y;

  /* draw a dot on click-without-move */
  ctx.beginPath();
  ctx.arc(x, y, state.size / 2, 0, Math.PI * 2);
  ctx.fillStyle = state.color;
  ctx.fill();
}

/**
 * draw - Extend the current stroke on pointermove.
 *
 * Uses quadratic Bézier midpoints for smooth curves.
 *
 * @param {PointerEvent} e
 */
function draw(e) {
  if (!state.drawing) return;
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
}

/**
 * stopDraw - End the current stroke on pointerup / pointerleave.
 *
 * @param {PointerEvent} e
 */
function stopDraw(e) {
  if (!state.drawing) return;
  e.preventDefault();
  state.drawing = false;
  ctx.closePath();
}

/* ============================================================
 * Custom brush cursor
 * ============================================================ */

/**
 * updateCursor - Reposition and resize the brush cursor overlay.
 *
 * The cursor div is a circle that tracks pointer position on the
 * canvas wrapper, reflecting current brush size and color.
 *
 * @param {PointerEvent} e
 */
function updateCursor(e) {
  const rect = canvas.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const y    = e.clientY - rect.top;

  /* brush size in CSS pixels (canvas pixel → CSS pixel) */
  const cssSize = state.size * (rect.width / canvas.width);

  brushCursor.style.left   = `${x}px`;
  brushCursor.style.top    = `${y}px`;
  brushCursor.style.width  = `${cssSize}px`;
  brushCursor.style.height = `${cssSize}px`;
}

function showCursor() { brushCursor.style.display = 'block'; }
function hideCursor() { brushCursor.style.display = 'none';  }

/* ============================================================
 * Toolbar — color
 * ============================================================ */

/**
 * setColor - Update active drawing color and sync all UI.
 *
 * @param {string} hex  — CSS hex color string
 */
function setColor(hex) {
  state.color = hex;
  ctx.strokeStyle = hex;
  colorPicker.value = hex;

  /* update active swatch */
  document.querySelectorAll('.swatch[data-color]').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === hex);
  });
}

/* swatch click */
document.querySelectorAll('.swatch[data-color]').forEach((btn) => {
  btn.addEventListener('click', () => setColor(btn.dataset.color));
});

/* native color picker */
colorPicker.addEventListener('input', (e) => setColor(e.target.value));

/* ============================================================
 * Toolbar — brush size
 * ============================================================ */

/**
 * setSize - Update brush size and sync UI.
 *
 * @param {number} px
 */
function setSize(px) {
  state.size      = px;
  ctx.lineWidth   = px;

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

/** clearCanvas - Wipe the entire canvas to transparent black. */
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

clearBtn.addEventListener('click', clearCanvas);

/* ============================================================
 * Canvas event listeners
 * ============================================================ */
canvas.addEventListener('pointerdown',  startDraw,  { passive: false });
canvas.addEventListener('pointermove',  draw,       { passive: false });
canvas.addEventListener('pointerup',    stopDraw,   { passive: false });
canvas.addEventListener('pointerleave', stopDraw,   { passive: false });

/* custom cursor tracking */
canvas.addEventListener('pointermove', updateCursor, { passive: true });
canvas.addEventListener('pointerenter', showCursor,  { passive: true });
canvas.addEventListener('pointerleave', hideCursor,  { passive: true });

/* ============================================================
 * Init
 * ============================================================ */

/** init - Bootstrap canvas dimensions and default context state. */
function init() {
  resize();
  applyCtxDefaults();
}

window.addEventListener('resize', resize);
init();

/* ============================================================
 * Guess box — Fase 1c
 * ============================================================ */

/**
 * WORD_LIST - Hardcoded pool of drawable nouns.
 *
 * All lowercase; matching is case-insensitive.
 * Extend this array freely — no networking required.
 *
 * @type {string[]}
 */
const WORD_LIST = [
  'kucing', 'anjing', 'rumah', 'pohon', 'mobil',
  'sepeda', 'matahari', 'bulan', 'bintang', 'awan',
  'hujan', 'gunung', 'laut', 'pantai', 'kapal',
  'pesawat', 'buku', 'pensil', 'payung', 'topi',
  'bunga', 'apel', 'pisang', 'jeruk', 'nasi',
  'pizza', 'roti', 'kunci', 'jam', 'telepon',
];

/* ----- guess state ----- */
/** @type {{ word: string, scoreCorrect: number, scoreWrong: number }} */
const guessState = {
  word:         '',
  scoreCorrect: 0,
  scoreWrong:   0,
};

/* ----- guess DOM refs ----- */
const guessForm     = /** @type {HTMLFormElement}   */ (document.getElementById('guessForm'));
const guessInput    = /** @type {HTMLInputElement}  */ (document.getElementById('guessInput'));
const feedbackEl    = /** @type {HTMLParagraphElement} */ (document.getElementById('feedback'));
const wordSlotsEl   = /** @type {HTMLDivElement}    */ (document.getElementById('wordSlots'));
const wordHintEl    = /** @type {HTMLSpanElement}   */ (document.getElementById('wordHint'));
const scoreCorrectEl = /** @type {HTMLElement}      */ (document.getElementById('scoreCorrect'));
const scoreWrongEl   = /** @type {HTMLElement}      */ (document.getElementById('scoreWrong'));

/* feedback auto-clear timer handle */
let feedbackTimer = 0;

/* ============================================================
 * Word helpers
 * ============================================================ */

/**
 * pickWord - Choose a random word from WORD_LIST.
 *
 * Avoids repeating the same word twice in a row when the pool
 * is large enough.
 *
 * @returns {string}
 */
function pickWord() {
  if (WORD_LIST.length === 1) return WORD_LIST[0];

  let candidate;
  do {
    candidate = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  } while (candidate === guessState.word);

  return candidate;
}

/**
 * renderWordSlots - Render blank letter-slot divs for the current word.
 *
 * Each character gets its own slot; spaces get a narrow gap div.
 * Slots are intentionally empty (underscores shown via CSS border-bottom).
 */
function renderWordSlots() {
  wordSlotsEl.innerHTML = '';

  for (const ch of guessState.word) {
    const slot = document.createElement('div');

    if (ch === ' ') {
      slot.className = 'letter-slot space-gap';
    } else {
      slot.className = 'letter-slot';
      /* data-char stored for future "reveal hint" feature */
      slot.dataset.char = ch;
    }

    wordSlotsEl.appendChild(slot);
  }

  /* e.g. "(5 huruf)" */
  const len = guessState.word.replace(/ /g, '').length;
  wordHintEl.textContent = `(${len} huruf)`;
}

/**
 * nextWord - Pick a new word, clear the canvas, reset the input.
 */
function nextWord() {
  guessState.word = pickWord();
  renderWordSlots();
  clearCanvas();
  guessInput.value = '';
  guessInput.focus();
}

/* ============================================================
 * Feedback helpers
 * ============================================================ */

/**
 * showFeedback - Display a feedback message, then auto-clear it.
 *
 * @param {string}  text      — Message to display
 * @param {'correct'|'wrong'} kind — Controls CSS class + colour
 * @param {number}  [ms=2200] — Auto-clear delay in milliseconds
 */
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

/**
 * triggerShake - Briefly animate the input on wrong answer.
 */
function triggerShake() {
  guessInput.classList.remove('shake');
  /* force reflow so re-adding the class restarts the animation */
  void guessInput.offsetWidth;
  guessInput.classList.add('shake');
  guessInput.addEventListener('animationend', () => {
    guessInput.classList.remove('shake');
  }, { once: true });
}

/* ============================================================
 * Submit handler
 * ============================================================ */

/**
 * handleGuess - Evaluate the player's guess against the current word.
 *
 * Comparison is case-insensitive and trims leading/trailing whitespace.
 * On correct guess: update score, show feedback, then pick next word.
 * On wrong guess:   update score, show feedback, shake input.
 *
 * @param {Event} e
 */
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
    /* delay nextWord so player can read the feedback */
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
 * Bootstrap guess box
 * ============================================================ */
nextWord();

/* ============================================================
 * Chat — Fase 2b
 * ============================================================ */

/* ----- DOM refs ----- */
const chatForm  = /** @type {HTMLFormElement}  */ (document.getElementById('chatForm'));
const chatInput = /** @type {HTMLInputElement} */ (document.getElementById('chatInput'));
const chatList  = /** @type {HTMLOListElement} */ (document.getElementById('chatList'));

/**
 * appendChatMessage - Render one chat bubble into the message list.
 *
 * Self messages align right (blue); peer messages align left (dark).
 * Timestamps are formatted as HH:MM local time.
 *
 * @param {{ text: string, from: string, ts: number, self: boolean }} msg
 */
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

  /* auto-scroll to latest message */
  chatList.scrollTop = chatList.scrollHeight;
}

/**
 * escapeHtml - Sanitize user text before inserting as innerHTML.
 *
 * Prevents XSS from chat messages sent by other clients.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* receive messages from other tabs/browsers */
onChatMessage(appendChatMessage);

/* send on form submit */
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.focus();

  try {
    await sendChat(text);
  } catch (err) {
    /* sendChat already showed the message optimistically;
       only need to handle the error case */
    appendChatMessage({
      text: `⚠ Gagal kirim: ${err.message}`,
      from: 'system',
      ts:   Date.now(),
      self: false,
    });
  }
});
