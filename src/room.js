/**
 * src/room.js — Room lifecycle + broadcast + Supabase Postgres Authority
 *
 * Fase 2a: Supabase Realtime Presence channel per room.
 * Fase 2b: broadcast 'chat' events.
 * Fase 2c: broadcast 'stroke' and 'clear' events real-time.
 * Fase 3a: broadcast 'new-word' (Host-authoritative: hanya hint/slot tersensor).
 * Fase 3b: broadcast 'guess-attempt' & 'guess-result'.
 * Fase 3c: sistem giliran round-robin ('turn-change') + timer.
 * Fase 4b/4c: power-up reveal-letter, freeze-rivals, extra-time.
 * Fase Waiting Room: Room lifecycle (waiting -> started -> finished),
 *                    Postgres RPCs, dan Randomized First Drawer.
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

/** @type {Array<{id: string, name: string, is_host: boolean, joined_at: number, online: boolean}>} */
let _memberDetails = [];

/** @type {Array<(status: string) => void>} */
const _statusListeners = [];

/** @type {Array<(count: number, keys: string[]) => void>} */
const _memberListeners = [];

/** @type {Array<(members: Array<{id: string, name: string, is_host: boolean, joined_at: number, online: boolean}>) => void>} */
const _memberPresenceListeners = [];

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

/** @type {Array<(msg: {powerup: string, from: string, ts: number, self: boolean}) => void>} */
const _powerupRequestListeners = [];

/** @type {Array<(msg: {powerup: string, from: string, hint?: any, initiatorId?: string, duration?: number, ts: number, self: boolean}) => void>} */
const _powerupAppliedListeners = [];

/** @type {Array<(msg: {powerup: string, from: string, ts: number, self: boolean}) => void>} */
const _powerupEndListeners = [];

/** @type {Array<(msg: {player: any, from: string, ts: number, self: boolean}) => void>} */
const _playerJoinedListeners = [];

/** @type {Array<(msg: {playerId: string, from: string, ts: number, self: boolean}) => void>} */
const _playerLeftListeners = [];

/** @type {Array<(msg: {roomCode: string, players: any[], firstDrawerId: string, startedAt: any, from: string, ts: number, self: boolean}) => void>} */
const _gameStartListeners = [];

/** @type {Array<(msg: {scores: Record<string, number>, leaderboard: any[], lastAward?: any, from: string, ts: number, self: boolean}) => void>} */
const _scoreUpdateListeners = [];

/** @type {Array<(msg: {reason: string, message: string, leaderboard: any[], finalScores: Record<string, number>, from: string, ts: number, self: boolean}) => void>} */
const _gameOverListeners = [];

/* ============================================================
 * Listener registration
 * ============================================================ */

/** @param {(status: string) => void} fn */
export function onStatusChange(fn) { _statusListeners.push(fn); }

/** @param {(count: number, keys: string[]) => void} fn */
export function onMemberChange(fn) { _memberListeners.push(fn); }

/** @param {(members: Array<{id: string, name: string, is_host: boolean, joined_at: number, online: boolean}>) => void} fn */
export function onMemberPresence(fn) { _memberPresenceListeners.push(fn); }

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

/** @param {(msg: {powerup: string, from: string, ts: number, self: boolean}) => void} fn */
export function onPowerupRequest(fn) { _powerupRequestListeners.push(fn); }

/** @param {(msg: {powerup: string, from: string, hint?: any, initiatorId?: string, duration?: number, ts: number, self: boolean}) => void} fn */
export function onPowerupApplied(fn) { _powerupAppliedListeners.push(fn); }

/** @param {(msg: {powerup: string, from: string, ts: number, self: boolean}) => void} fn */
export function onPowerupEnd(fn) { _powerupEndListeners.push(fn); }

/** @param {(msg: {player: any, from: string, ts: number, self: boolean}) => void} fn */
export function onPlayerJoined(fn) { _playerJoinedListeners.push(fn); }

/** @param {(msg: {playerId: string, from: string, ts: number, self: boolean}) => void} fn */
export function onPlayerLeft(fn) { _playerLeftListeners.push(fn); }

/** @param {(msg: {roomCode: string, players: any[], firstDrawerId: string, startedAt: any, from: string, ts: number, self: boolean}) => void} fn */
export function onGameStart(fn) { _gameStartListeners.push(fn); }

/** @param {(msg: {scores: Record<string, number>, leaderboard: any[], lastAward?: any, from: string, ts: number, self: boolean}) => void} fn */
export function onScoreUpdate(fn) { _scoreUpdateListeners.push(fn); }

/** @param {(msg: {reason: string, message: string, leaderboard: any[], finalScores: Record<string, number>, from: string, ts: number, self: boolean}) => void} fn */
export function onGameOver(fn) { _gameOverListeners.push(fn); }

function _emitStatus(s)            { _statusListeners.forEach((fn) => fn(s)); }
function _emitMembers(n, keys)     { _memberListeners.forEach((fn) => fn(n, keys)); }
function _emitMemberPresence(m)    { _memberPresenceListeners.forEach((fn) => fn(m)); }
function _emitChat(msg)            { _chatListeners.forEach((fn) => fn(msg)); }
function _emitStroke(msg)          { _strokeListeners.forEach((fn) => fn(msg)); }
function _emitClear(msg)           { _clearListeners.forEach((fn) => fn(msg)); }
function _emitNewWord(msg)         { _newWordListeners.forEach((fn) => fn(msg)); }
function _emitGuessAttempt(msg)    { _guessAttemptListeners.forEach((fn) => fn(msg)); }
function _emitGuessResult(msg)     { _guessResultListeners.forEach((fn) => fn(msg)); }
function _emitTurnChange(msg)      { _turnChangeListeners.forEach((fn) => fn(msg)); }
function _emitPowerupRequest(msg)  { _powerupRequestListeners.forEach((fn) => fn(msg)); }
function _emitPowerupApplied(msg)  { _powerupAppliedListeners.forEach((fn) => fn(msg)); }
function _emitPowerupEnd(msg)      { _powerupEndListeners.forEach((fn) => fn(msg)); }
function _emitPlayerJoined(msg)    { _playerJoinedListeners.forEach((fn) => fn(msg)); }
function _emitPlayerLeft(msg)      { _playerLeftListeners.forEach((fn) => fn(msg)); }
function _emitGameStart(msg)       { _gameStartListeners.forEach((fn) => fn(msg)); }
function _emitScoreUpdate(msg)     { _scoreUpdateListeners.forEach((fn) => fn(msg)); }
function _emitGameOver(msg)        { _gameOverListeners.forEach((fn) => fn(msg)); }

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

/** getMemberDetails - List of current member presence details (name, is_host, etc.). */
export function getMemberDetails() { return [..._memberDetails]; }

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

/**
 * getPlayerName - Ambil nama pemain dari sessionStorage (atau default).
 */
export function getPlayerName() {
  const K = 'tebak-gambar:player-name';
  let name = sessionStorage.getItem(K);
  if (!name || !name.trim()) {
    name = `Pemain ${getSelfKey().slice(0, 4)}`;
    sessionStorage.setItem(K, name);
  }
  return name.trim();
}

/**
 * setPlayerName - Simpan nama pemain ke sessionStorage.
 */
export function setPlayerName(name) {
  const K = 'tebak-gambar:player-name';
  const clean = (name || '').trim();
  if (clean) {
    sessionStorage.setItem(K, clean);
  }
  return clean;
}

/**
 * getSavedRoomCode - Ambil kode room aktif dari sessionStorage untuk reconnect.
 */
export function getSavedRoomCode() {
  return sessionStorage.getItem('tebak-gambar:room-code');
}

/**
 * setSavedRoomCode - Simpan kode room aktif ke sessionStorage.
 */
export function setSavedRoomCode(code) {
  if (code) {
    sessionStorage.setItem('tebak-gambar:room-code', code.toUpperCase().trim());
  } else {
    sessionStorage.removeItem('tebak-gambar:room-code');
  }
}

/**
 * getSavedIsHost - Ambil status host dari sessionStorage.
 */
export function getSavedIsHost() {
  return sessionStorage.getItem('tebak-gambar:is-host') === 'true';
}

/**
 * setSavedIsHost - Simpan status host ke sessionStorage.
 */
export function setSavedIsHost(isHost) {
  sessionStorage.setItem('tebak-gambar:is-host', isHost ? 'true' : 'false');
}

/* ============================================================
 * Join Realtime Channel
 * ============================================================ */

/**
 * joinRoom - Subscribe to a Supabase Realtime channel and return a
 * Promise that resolves when the WebSocket is SUBSCRIBED.
 *
 * @param {string} roomCode
 * @param {{ name?: string, isHost?: boolean }} [options]
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
export function joinRoom(roomCode, { name, isHost = false } = {}) {
  const code = roomCode.trim().toUpperCase();
  const playerName = name || getPlayerName();

  return new Promise(async (resolve, reject) => {
    if (!supabase) {
      return reject(new Error('Kredensial Supabase di .env belum terbaca atau belum diset.'));
    }

    /* leave existing channel first */
    await leaveRoom();

    _roomCode = code;
    setSavedRoomCode(code);
    setSavedIsHost(isHost);
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

    /* ---- Presence: member count, keys, & details ---- */
    _channel.on('presence', { event: 'sync' }, () => {
      const state = _channel.presenceState();
      _presenceKeys = Object.keys(state).sort();

      const memberMap = new Map();
      for (const [key, presences] of Object.entries(state)) {
        const latest = presences[presences.length - 1] || {};
        memberMap.set(key, {
          id:          key,
          name:        latest.name || `Pemain ${key.slice(0, 4)}`,
          is_host:     Boolean(latest.is_host),
          game_status: latest.game_status || 'waiting',
          joined_at:   latest.joined_at || Date.now(),
          online:      true,
        });
      }
      _memberDetails = Array.from(memberMap.values()).sort((a, b) => a.joined_at - b.joined_at);

      _emitMembers(_presenceKeys.length, _presenceKeys);
      _emitMemberPresence(_memberDetails);
    });

    /* ---- Broadcast: player-joined (Waiting Room) ---- */
    _channel.on('broadcast', { event: 'player-joined' }, ({ payload }) => {
      if (!payload) return;
      _emitPlayerJoined({
        player: payload.player,
        from:   payload.from,
        ts:     payload.ts,
        self:   payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: player-left (Waiting Room) ---- */
    _channel.on('broadcast', { event: 'player-left' }, ({ payload }) => {
      if (!payload) return;
      _emitPlayerLeft({
        playerId: payload.playerId,
        from:     payload.from,
        ts:       payload.ts,
        self:     payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: game-start (Waiting Room -> Game) ---- */
    _channel.on('broadcast', { event: 'game-start' }, ({ payload }) => {
      if (!payload) return;
      if (payload.from === getSelfKey()) return; // Sender sudah memprosesnya secara lokal
      _emitGameStart({
        roomCode:      payload.roomCode,
        players:       payload.players,
        firstDrawerId: payload.firstDrawerId,
        startedAt:     payload.startedAt,
        totalRounds:   payload.totalRounds,
        from:          payload.from,
        ts:            payload.ts,
        self:          false,
      });
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
      if (payload.from === getSelfKey()) return; // Sender sudah memprosesnya secara lokal
      _emitGuessAttempt({
        guess: payload.guess,
        from:  payload.from,
        ts:    payload.ts,
        self:  false,
      });
    });

    /* ---- Broadcast: guess-result from Host to all Clients (Fase 3b & 5a) ---- */
    _channel.on('broadcast', { event: 'guess-result' }, ({ payload }) => {
      if (!payload) return;
      if (payload.from === getSelfKey()) return; // Host sudah memprosesnya secara lokal
      _emitGuessResult({
        ...payload,
        self: false,
      });
    });

    /* ---- Broadcast: game-over (Host Left or Game Terminated) ---- */
    _channel.on('broadcast', { event: 'game-over' }, ({ payload }) => {
      if (!payload) return;
      if (payload.from === getSelfKey()) return;
      _emitGameOver({
        reason:      payload.reason || 'host-left',
        message:     payload.message || 'Host telah meninggalkan room.',
        leaderboard: payload.leaderboard || [],
        finalScores: payload.finalScores || {},
        from:        payload.from,
        ts:          payload.ts,
        self:        false,
      });
    });

    /* ---- Broadcast: score-update from Host to all Clients (Fase 5a) ---- */
    _channel.on('broadcast', { event: 'score-update' }, ({ payload }) => {
      if (!payload) return;
      if (payload.from === getSelfKey()) return; // Sender sudah memprosesnya secara lokal
      _emitScoreUpdate({
        scores:      payload.scores,
        leaderboard: payload.leaderboard,
        lastAward:   payload.lastAward,
        from:        payload.from,
        ts:          payload.ts,
        self:        false,
      });
    });

    /* ---- Broadcast: turn-change from Host to all Clients (Fase 3c) ---- */
    _channel.on('broadcast', { event: 'turn-change' }, ({ payload }) => {
      if (!payload) return;
      if (payload.from === getSelfKey()) return; // Sender sudah memprosesnya secara lokal
      _emitTurnChange({
        drawerId:     payload.drawerId,
        drawerWord:   payload.drawerWord,
        hint:         payload.hint,
        duration:     payload.duration,
        startedAt:    payload.startedAt,
        currentRound: payload.currentRound,
        totalRounds:  payload.totalRounds,
        from:         payload.from,
        ts:           payload.ts,
        self:         false,
      });
    });

    /* ---- Broadcast: powerup-request from Client to Host (Fase 4b/4c) ---- */
    _channel.on('broadcast', { event: 'powerup-request' }, ({ payload }) => {
      if (!payload) return;
      _emitPowerupRequest({
        powerup: payload.powerup,
        from:    payload.from,
        ts:      payload.ts,
        self:    payload.from === getSelfKey(),
      });
    });

    /* ---- Broadcast: powerup-applied from Host to all Clients (Fase 4b/4c) ---- */
    _channel.on('broadcast', { event: 'powerup-applied' }, ({ payload }) => {
      if (!payload) return;
      _emitPowerupApplied({
        ...payload,
        self: payload.from === getSelfKey() || payload.initiatorId === getSelfKey(),
      });
    });

    /* ---- Broadcast: powerup-end from Host to all Clients (Fase 4c) ---- */
    _channel.on('broadcast', { event: 'powerup-end' }, ({ payload }) => {
      if (!payload) return;
      _emitPowerupEnd({
        ...payload,
        self: payload.from === getSelfKey(),
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
            await _channel.track({
              id:          getSelfKey(),
              name:        playerName,
              is_host:     Boolean(isHost),
              game_status: 'waiting',
              joined_at:   Date.now(),
            });
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
 * leaveRoom - Untrack presence, inform peers, and tear down the channel.
 */
export async function leaveRoom() {
  const code = _roomCode;
  const selfKey = getSelfKey();

  if (code && selfKey) {
    try {
      await sendPlayerLeft(selfKey);
      await dbLeaveRoom(code, selfKey);
    } catch (_) {}
  }

  if (_channel) {
    try {
      await _channel.untrack();
      if (supabase) await supabase.removeChannel(_channel);
    } catch (_) { /* ignore cleanup errors */ }
  }

  _channel       = null;
  _roomCode      = null;
  _presenceKeys  = [];
  _memberDetails = [];
  setSavedRoomCode(null);
  setSavedIsHost(false);

  _emitStatus('disconnected');
  _emitMembers(0, []);
  _emitMemberPresence([]);
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

  const payload = {
    guess,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  /* Picu handler lokal untuk Host agar validasi berjalan instan */
  _emitGuessAttempt({ ...payload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'guess-attempt',
    payload,
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

/* ============================================================
 * Broadcast: Power-up (Fase 4b & 4c)
 * ============================================================ */

/**
 * sendPowerupRequest - Client requests a powerup from Host.
 *
 * @param {string} powerup - 'reveal-letter' | 'freeze-rivals' | 'extra-time'
 */
export async function sendPowerupRequest(powerup) {
  if (!_channel) return;

  const payload = {
    powerup,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  /* Host juga memicu listener lokal jika pengirim adalah host */
  _emitPowerupRequest({ ...payload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'powerup-request',
    payload,
  });
}

/**
 * sendPowerupApplied - Host broadcasts applied powerup effect.
 *
 * @param {object} payload
 */
export async function sendPowerupApplied(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  _emitPowerupApplied({ ...fullPayload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'powerup-applied',
    payload: fullPayload,
  });
}

/**
 * sendPowerupEnd - Host broadcasts the expiration of a timed powerup.
 *
 * @param {object} payload
 */
export async function sendPowerupEnd(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  _emitPowerupEnd({ ...fullPayload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'powerup-end',
    payload: fullPayload,
  });
}

/* ============================================================
 * Broadcast: Waiting Room & Lifecycle
 * ============================================================ */

/**
 * sendPlayerJoined - Inform room that a player joined.
 *
 * @param {object} player
 */
export async function sendPlayerJoined(player) {
  if (!_channel) return;
  await _channel.send({
    type:    'broadcast',
    event:   'player-joined',
    payload: { player, from: getSelfKey(), ts: Date.now() },
  });
}

/**
 * sendPlayerLeft - Inform room that a player left.
 *
 * @param {string} playerId
 */
export async function sendPlayerLeft(playerId) {
  if (!_channel) return;
  await _channel.send({
    type:    'broadcast',
    event:   'player-left',
    payload: { playerId, from: getSelfKey(), ts: Date.now() },
  });
}

/**
 * sendGameStart - Host broadcasts transition to gameplay.
 *
 * @param {object} payload
 * @param {string} payload.roomCode
 * @param {any[]} payload.players
 * @param {string} payload.firstDrawerId
 * @param {any} payload.startedAt
 */
export async function sendGameStart(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  /* Siarkan event game-start ke seluruh peer terlebih dahulu */
  await _channel.send({
    type:    'broadcast',
    event:   'game-start',
    payload: fullPayload,
  });

  /* Host memproses transisi ke permainan secara lokal */
  _emitGameStart({ ...fullPayload, self: true });
}

/**
 * sendScoreUpdate - Host broadcasts updated scores & leaderboard (Fase 5a).
 *
 * @param {object} payload
 * @param {Record<string, number>} payload.scores
 * @param {any[]} payload.leaderboard
 * @param {any} [payload.lastAward]
 */
export async function sendScoreUpdate(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  _emitScoreUpdate({ ...fullPayload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'score-update',
    payload: fullPayload,
  });
}

/**
 * sendGameOver - Broadcast that the game has concluded / host has left.
 *
 * @param {object} payload
 * @param {string} payload.reason
 * @param {string} payload.message
 * @param {any[]} [payload.leaderboard]
 * @param {Record<string, number>} [payload.finalScores]
 */
export async function sendGameOver(payload) {
  if (!_channel) return;

  const fullPayload = {
    ...payload,
    from: getSelfKey(),
    ts:   Date.now(),
  };

  /* Siarkan event game-over ke seluruh client */
  await _channel.send({
    type:    'broadcast',
    event:   'game-over',
    payload: fullPayload,
  });

  _emitGameOver({ ...fullPayload, self: true });
}

/* ============================================================
 * Supabase Postgres Authoritative RPCs & Fallback Handling
 * ============================================================ */

/**
 * isSchemaMissing - Mendeteksi apakah error berasal dari fungsi/tabel
 * yang belum dieksekusi di Supabase SQL Editor (PGRST202/PGRST205/schema cache).
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isSchemaMissing(error) {
  if (!error) return false;
  const msg = (error.message || error.details || error.hint || String(error)).toLowerCase();
  const code = (error.code || '').toUpperCase();
  return (
    code === 'PGRST202' ||
    code === 'PGRST205' ||
    code === '42883' ||
    code === '42P01' ||
    msg.includes('schema cache') ||
    msg.includes('could not find the function') ||
    msg.includes('could not find the table') ||
    msg.includes('create_room_rpc') ||
    msg.includes('join_room_rpc') ||
    msg.includes('start_room_rpc') ||
    msg.includes('get_room_state_rpc') ||
    msg.includes('leave_room_rpc')
  );
}

/**
 * setPresenceGameStatus - Update status permainan pada kehadiran Realtime channel.
 *
 * @param {'waiting' | 'started' | 'finished'} status
 */
export async function setPresenceGameStatus(status) {
  if (!_channel) return;
  try {
    await _channel.track({
      id:          getSelfKey(),
      name:        getPlayerName(),
      is_host:     getSavedIsHost(),
      game_status: status,
      joined_at:   Date.now(),
    });
  } catch (_) {}
}

/**
 * dbCreateRoom - Create room in PostgreSQL.
 * Jika RPC belum ada di database, jatuh ke mode Realtime Presence tanpa error.
 */
export async function dbCreateRoom(roomCode, playerId, playerName) {
  if (!supabase) return { success: true, localOnly: true, status: 'waiting' };

  try {
    const { data, error } = await supabase.rpc('create_room_rpc', {
      p_room_code:        roomCode,
      p_host_player_id:   playerId,
      p_host_player_name: playerName,
      p_max_players:      8,
    });

    if (error) {
      if (isSchemaMissing(error)) {
        console.info('[dbCreateRoom] Database RPC not deployed yet, falling back to Realtime Presence.');
        return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
      }
      console.warn('[dbCreateRoom] RPC notice:', error.message);
      return { success: false, error: error.message };
    }
    return data || { success: true, status: 'waiting' };
  } catch (err) {
    if (isSchemaMissing(err)) {
      return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
    }
    console.warn('[dbCreateRoom] error:', err);
    return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
  }
}

/**
 * dbJoinRoom - Join room with database transaction row-lock (SELECT ... FOR UPDATE).
 * Jika RPC belum ada di database, jatuh ke mode Realtime Presence tanpa error.
 */
export async function dbJoinRoom(roomCode, playerId, playerName) {
  if (!supabase) return { success: true, localOnly: true, status: 'waiting' };

  try {
    const { data, error } = await supabase.rpc('join_room_rpc', {
      p_room_code:   roomCode,
      p_player_id:   playerId,
      p_player_name: playerName,
    });

    if (error) {
      if (isSchemaMissing(error)) {
        console.info('[dbJoinRoom] Database RPC not deployed yet, falling back to Realtime Presence.');
        return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
      }
      console.warn('[dbJoinRoom] RPC notice:', error.message);
      return { success: false, error: error.message };
    }
    return data || { success: true, status: 'waiting' };
  } catch (err) {
    if (isSchemaMissing(err)) {
      return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
    }
    console.warn('[dbJoinRoom] error:', err);
    return { success: true, localOnly: true, room_code: roomCode, status: 'waiting' };
  }
}

/**
 * dbStartRoom - Host starts room with database transaction row-lock & randomized drawer.
 * Jika RPC belum ada di database, memicu fallback ke pemilihan acak in-memory.
 */
export async function dbStartRoom(roomCode, hostPlayerId, minPlayers = 1) {
  if (!supabase) return { success: false, fallback: true, error: 'Database Supabase tidak terhubung' };

  try {
    const { data, error } = await supabase.rpc('start_room_rpc', {
      p_room_code:      roomCode,
      p_host_player_id: hostPlayerId,
      p_min_players:    minPlayers,
    });

    if (error) {
      if (isSchemaMissing(error)) {
        console.info('[dbStartRoom] Database RPC not deployed yet, fallback to in-memory randomized selection.');
        return { success: false, fallback: true, error: error.message };
      }
      console.warn('[dbStartRoom] RPC notice:', error.message);
      return { success: false, fallback: true, error: error.message };
    }
    return data;
  } catch (err) {
    console.warn('[dbStartRoom] error:', err);
    return { success: false, fallback: true, error: err.message };
  }
}

/**
 * dbGetRoomState - Get room state & player snapshot from PostgreSQL.
 */
export async function dbGetRoomState(roomCode) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('get_room_state_rpc', {
      p_room_code: roomCode,
    });

    if (error) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * dbLeaveRoom - Remove player from PostgreSQL room_players.
 */
export async function dbLeaveRoom(roomCode, playerId) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('leave_room_rpc', {
      p_room_code: roomCode,
      p_player_id: playerId,
    });

    if (error) return null;
    return data;
  } catch (_) {
    return null;
  }
}
