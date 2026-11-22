/**
 * src/room.js — Room lifecycle + broadcast
 *
 * Fase 2a: Supabase Realtime Presence channel per room.
 * Fase 2b: broadcast 'chat' events.
 * Fase 2c: broadcast 'stroke' and 'clear' events real-time.
 * Fase 3a: broadcast 'new-word' (Host-authoritative: hanya hint/slot tersensor).
 * Fase 3b: broadcast 'guess-attempt' & 'guess-result'.
 * Fase 3c: sistem giliran round-robin ('turn-change') + timer.
 *
 * Public API:
 *   joinRoom(roomCode)          → Promise<channel>; resolves on SUBSCRIBED
 *   leaveRoom()                 → unsubscribes + cleans up
 *   sendChat(text)              → broadcast {type:'chat', text, from, ts}
 *   sendStroke(data)            → broadcast {type:'stroke', data, from, ts}
 *   sendClear()                 → broadcast {type:'clear', from, ts}
 *   sendNewWord(hint)           → broadcast {type:'new-word', hint, from, ts}
 *   sendGuessAttempt(guess)     → broadcast {type:'guess-attempt', guess, from, ts}
 *   sendGuessResult(result)     → broadcast {type:'guess-result', ...result, from, ts}
 *   sendTurnChange(payload)     → broadcast {type:'turn-change', ...payload, from, ts}
 *   onStatusChange(fn)          → 'connecting'|'connected'|'disconnected'|'error'
 *   onMemberChange(fn)          → (count, keys)
 *   onChatMessage(fn)           → {text, from, ts, self}
 *   onStroke(fn)                → {stroke, from, self}
 *   onClear(fn)                 → {from, self}
 *   onNewWord(fn)               → {hint, from, self}
 *   onGuessAttempt(fn)          → {guess, from, ts, self}
 *   onGuessResult(fn)           → {isCorrect, guesserId, guess, word, from, ts, self}
 *   onTurnChange(fn)            → {drawerId, drawerWord, hint, duration, startedAt, from, ts, self}
 *   currentRoom()               → room code | null
 *   generateRoomCode()          → random 6-char code
 *   getSelfKey()                → string short id
 *   getRoomMemberKeys()         → string[] list of presence keys
 */

import { supabase } from './supabase.js';

/* ============================================================
 * Internal state
 * ============================================================ */

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let _channel = null;

/** @type {string | null} */
let _roomCode = null;

/** @type {string[]} */
let _presenceKeys = [];

/** @type {Array<(status: string) => void>} */
const _statusListeners = [];

/** @type {Array<(count: number, keys: string[]) => void>} */
const _memberListeners = [];

/** @type {Array<(msg: {text: string, from: string, ts: number, self: boolean}) => void>} */
const _chatListeners = [];

/** @type {Array<(msg: {stroke: any, from: string, ts: number, self: boolean}) => void>} */
const _strokeListeners = [];

/** @type {Array<(msg: {from: string, ts: number, self: boolean}) => void>} */
const _clearListeners = [];

/** @type {Array<(msg: {hint: any, from: string, ts: number, self: boolean}) => void>} */
const _newWordListeners = [];

/** @type {Array<(msg: {guess: string, from: string, ts: number, self: boolean}) => void>} */
const _guessAttemptListeners = [];

/** @type {Array<(msg: {isCorrect: boolean, guesserId: string, guess: string, word: string|null, from: string, ts: number, self: boolean}) => void>} */
const _guessResultListeners = [];

/** @type {Array<(msg: {drawerId: string, drawerWord: string, hint: any, duration: number, startedAt: number, from: string, ts: number, self: boolean}) => void>} */
const _turnChangeListeners = [];

/* ============================================================
 * Listener registration
 * ============================================================ */

/** @param {(status: string) => void} fn */
export function onStatusChange(fn) { _statusListeners.push(fn); }

/** @param {(count: number, keys: string[]) => void} fn */
export function onMemberChange(fn) { _memberListeners.push(fn); }

/** @param {(msg: {text: string, from: string, ts: number, self: boolean}) => void} fn */
export function onChatMessage(fn) { _chatListeners.push(fn); }

/** @param {(msg: {stroke: any, from: string, ts: number, self: boolean}) => void} fn */
export function onStroke(fn) { _strokeListeners.push(fn); }

/** @param {(msg: {from: string, ts: number, self: boolean}) => void} fn */
export function onClear(fn) { _clearListeners.push(fn); }

/** @param {(msg: {hint: any, from: string, ts: number, self: boolean}) => void} fn */
export function onNewWord(fn) { _newWordListeners.push(fn); }

/** @param {(msg: {guess: string, from: string, ts: number, self: boolean}) => void} fn */
export function onGuessAttempt(fn) { _guessAttemptListeners.push(fn); }

/** @param {(msg: {isCorrect: boolean, guesserId: string, guess: string, word: string|null, from: string, ts: number, self: boolean}) => void} fn */
export function onGuessResult(fn) { _guessResultListeners.push(fn); }

/** @param {(msg: {drawerId: string, drawerWord: string, hint: any, duration: number, startedAt: number, from: string, ts: number, self: boolean}) => void} fn */
export function onTurnChange(fn) { _turnChangeListeners.push(fn); }

function _emitStatus(s)         { _statusListeners.forEach((fn) => fn(s)); }
function _emitMembers(n, keys)  { _memberListeners.forEach((fn) => fn(n, keys)); }
function _emitChat(msg)         { _chatListeners.forEach((fn) => fn(msg)); }
function _emitStroke(msg)       { _strokeListeners.forEach((fn) => fn(msg)); }
function _emitClear(msg)        { _clearListeners.forEach((fn) => fn(msg)); }
function _emitNewWord(msg)      { _newWordListeners.forEach((fn) => fn(msg)); }
function _emitGuessAttempt(msg) { _guessAttemptListeners.forEach((fn) => fn(msg)); }
function _emitGuessResult(msg)  { _guessResultListeners.forEach((fn) => fn(msg)); }
function _emitTurnChange(msg)   { _turnChangeListeners.forEach((fn) => fn(msg)); }

/* ============================================================
 * Helpers
 * ============================================================ */

/**
 * generateRoomCode - Random 6-char code from unambiguous alphabet.
 * Excludes 0/O, 1/I/L.
 *
 * @returns {string}
 */
export function generateRoomCode() {
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return code;
}

/** currentRoom - Active room code, or null. */
export function currentRoom() { return _roomCode; }

/** getRoomMemberKeys - List of current member presence keys. */
export function getRoomMemberKeys() { return [..._presenceKeys]; }

/**
 * getSelfKey - Stable per-tab random identifier.
 *
 * @returns {string}
 */
export function getSelfKey() {
  const K = 'tebak-gambar:presence-key';
  let k = sessionStorage.getItem(K);
  if (!k) {
    k = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(K, k);
  }
  return k;
}

/* ============================================================
 * Join
 * ============================================================ */

/**
 * joinRoom - Subscribe to a Supabase Realtime channel and return a
 * Promise that resolves when the WebSocket is SUBSCRIBED.
 *
 * @param {string} roomCode
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
export function joinRoom(roomCode) {
  const code = roomCode.trim().toUpperCase();

  return new Promise(async (resolve, reject) => {
    if (!supabase) {
      return reject(new Error('Kredensial Supabase di .env belum terbaca atau belum diset.'));
    }

    /* leave existing channel first */
    await leaveRoom();

    _roomCode = code;
    _emitStatus('connecting');

    _channel = supabase.channel(`room:${code}`, {
      config: { presence: { key: getSelfKey() } },
    });

    let isSettled = false;
    const timeoutHandle = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        _emitStatus('disconnected');
        reject(new Error('Koneksi timeout (10s) ke server Supabase. Pastikan koneksi internet aktif.'));
      }
    }, 10000);

    /* ---- Presence: member count & keys ---- */
    _channel.on('presence', { event: 'sync' }, () => {
      const state = _channel.presenceState();
      _presenceKeys = Object.keys(state).sort();
      _emitMembers(_presenceKeys.length, _presenceKeys);
    });

    /* ---- Broadcast: chat messages ---- */
    _channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (!payload) return;
      _emitChat({
        text: payload.text,
        from: payload.from,
        ts:   payload.ts,
        self: payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: stroke data (Fase 2c) ---- */
    _channel.on('broadcast', { event: 'stroke' }, ({ payload }) => {
      if (!payload) return;
      _emitStroke({
        stroke: payload.stroke,
        from:   payload.from,
        ts:     payload.ts,
        self:   payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: canvas clear (Fase 2c) ---- */
    _channel.on('broadcast', { event: 'clear' }, ({ payload }) => {
      if (!payload) return;
      _emitClear({
        from: payload.from,
        ts:   payload.ts,
        self: payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: new-word hint from Host (Fase 3a) ---- */
    _channel.on('broadcast', { event: 'new-word' }, ({ payload }) => {
      if (!payload) return;
      _emitNewWord({
        hint: payload.hint,
        from: payload.from,
        ts:   payload.ts,
        self: payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: guess-attempt from Client to Host (Fase 3b) ---- */
    _channel.on('broadcast', { event: 'guess-attempt' }, ({ payload }) => {
      if (!payload) return;
      _emitGuessAttempt({
        guess: payload.guess,
        from:  payload.from,
        ts:    payload.ts,
        self:  payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: guess-result from Host to all Clients (Fase 3b) ---- */
    _channel.on('broadcast', { event: 'guess-result' }, ({ payload }) => {
      if (!payload) return;
      _emitGuessResult({
        isCorrect: payload.isCorrect,
        guesserId: payload.guesserId,
        guess:     payload.guess,
        word:      payload.word,
        from:      payload.from,
        ts:        payload.ts,
        self:      payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: turn-change from Host to all Clients (Fase 3c) ---- */
    _channel.on('broadcast', { event: 'turn-change' }, ({ payload }) => {
      if (!payload) return;
      _emitTurnChange({
        drawerId:   payload.drawerId,
        drawerWord: payload.drawerWord,
        hint:       payload.hint,
        duration:   payload.duration,
        startedAt:  payload.startedAt,
        from:       payload.from,
        ts:         payload.ts,
        self:       payload.from === getSelfKey(),
      });
    });

    /* ---- Subscribe → resolve/reject the Promise ---- */
    _channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutHandle);
          _emitStatus('connected');
          try {
            await _channel.track({ joined_at: Date.now() });
          } catch (_) {}
          resolve(_channel);
        }
      } else if (status === 'CHANNEL_ERROR') {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutHandle);
          _emitStatus('error');
          reject(new Error('Channel error — periksa kredensial Supabase.'));
        }
      } else if (status === 'TIMED_OUT') {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutHandle);
          _emitStatus('disconnected');
          reject(new Error('Koneksi timeout — coba lagi.'));
        }
      } else if (status === 'CLOSED') {
        _emitStatus('disconnected');
      }
    });
  });
}

/* ============================================================
 * Leave
 * ============================================================ */

/**
 * leaveRoom - Untrack presence and tear down the channel.
 */
export async function leaveRoom() {
  if (!_channel) return;
  try {
    await _channel.untrack();
    if (supabase) await supabase.removeChannel(_channel);
  } catch (_) { /* ignore cleanup errors */ }
  _channel      = null;
  _roomCode     = null;
  _presenceKeys = [];
  _emitStatus('disconnected');
  _emitMembers(0, []);
}

/* ============================================================
 * Broadcast: Chat
 * ============================================================ */

export async function sendChat(text) {
  if (!_channel) throw new Error('Belum terhubung ke room.');

  const payload = { text, from: getSelfKey(), ts: Date.now() };

  _emitChat({ ...payload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'chat',
    payload,
  });
}

/* ============================================================
 * Broadcast: Stroke (Fase 2c)
 * ============================================================ */

/**
 * sendStroke - Send batched stroke points to peers in the room.
 *
 * @param {object} strokeData
 */
export async function sendStroke(strokeData) {
  if (!_channel) return;

  await _channel.send({
    type:    'broadcast',
    event:   'stroke',
    payload: {
      stroke: strokeData,
      from:   getSelfKey(),
      ts:     Date.now(),
    },
  });
}

/* ============================================================
 * Broadcast: Clear (Fase 2c)
 * ============================================================ */

export async function sendClear() {
  if (!_channel) return;

  await _channel.send({
    type:    'broadcast',
    event:   'clear',
    payload: {
      from: getSelfKey(),
      ts:   Date.now(),
    },
  });
}

/* ============================================================
 * Broadcast: New Word Hint (Fase 3a - Host Authoritative)
 * ============================================================ */

export async function sendNewWord(hint) {
  if (!_channel) return;

  await _channel.send({
    type:    'broadcast',
    event:   'new-word',
    payload: {
      hint,
      from: getSelfKey(),
      ts:   Date.now(),
    },
  });
}

/* ============================================================
 * Broadcast: Guess Attempt & Result (Fase 3b)
 * ============================================================ */

export async function sendGuessAttempt(guess) {
  if (!_channel) return;

  await _channel.send({
    type:    'broadcast',
    event:   'guess-attempt',
    payload: {
      guess,
      from: getSelfKey(),
      ts:   Date.now(),
    },
  });
}

export async function sendGuessResult(result) {
  if (!_channel) return;

  const payload = {
    ...result,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  _emitGuessResult({ ...payload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'guess-result',
    payload,
  });
}

/* ============================================================
 * Broadcast: Turn Change (Fase 3c - Host Authoritative)
 * ============================================================ */

/**
 * sendTurnChange - Host broadcasts turn change (drawer, duration, word).
 *
 * @param {object} payload
 * @param {string} payload.drawerId
 * @param {string} payload.drawerWord
 * @param {object} payload.hint
 * @param {number} payload.duration
 * @param {number} payload.startedAt
 */
export async function sendTurnChange(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  /* Host juga mengeksekusi listener turn change miliknya sendiri */
  _emitTurnChange({ ...fullPayload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'turn-change',
    payload: fullPayload,
  });
}
