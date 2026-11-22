/**
 * src/room.js — Room lifecycle + broadcast (chat & canvas stroke)
 *
 * Fase 2a: Supabase Realtime Presence channel per room.
 * Fase 2b: broadcast 'chat' events.
 * Fase 2c: broadcast 'stroke' and 'clear' events real-time.
 *
 * Public API:
 *   joinRoom(roomCode)         → Promise<channel>; resolves on SUBSCRIBED
 *   leaveRoom()                → unsubscribes + cleans up
 *   sendChat(text)             → broadcast {type:'chat', text, from, ts}
 *   sendStroke(data)           → broadcast {type:'stroke', data, from, ts}
 *   sendClear()                → broadcast {type:'clear', from, ts}
 *   onStatusChange(fn)         → 'connecting'|'connected'|'disconnected'|'error'
 *   onMemberChange(fn)         → number of presence keys in room
 *   onChatMessage(fn)          → {text, from, ts, self} on every chat event
 *   onStroke(fn)               → {stroke, from, self} on stroke broadcast
 *   onClear(fn)                → {from, self} on clear broadcast
 *   currentRoom()              → room code | null
 *   generateRoomCode()         → random 6-char code
 *   getSelfKey()               → string short id
 */

import { supabase } from './supabase.js';

/* ============================================================
 * Internal state
 * ============================================================ */

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let _channel = null;

/** @type {string | null} */
let _roomCode = null;

/** @type {Array<(status: string) => void>} */
const _statusListeners = [];

/** @type {Array<(count: number) => void>} */
const _memberListeners = [];

/** @type {Array<(msg: {text: string, from: string, ts: number, self: boolean}) => void>} */
const _chatListeners = [];

/** @type {Array<(msg: {stroke: any, from: string, ts: number, self: boolean}) => void>} */
const _strokeListeners = [];

/** @type {Array<(msg: {from: string, ts: number, self: boolean}) => void>} */
const _clearListeners = [];

/* ============================================================
 * Listener registration
 * ============================================================ */

/** @param {(status: string) => void} fn */
export function onStatusChange(fn) { _statusListeners.push(fn); }

/** @param {(count: number) => void} fn */
export function onMemberChange(fn) { _memberListeners.push(fn); }

/** @param {(msg: {text: string, from: string, ts: number, self: boolean}) => void} fn */
export function onChatMessage(fn) { _chatListeners.push(fn); }

/** @param {(msg: {stroke: any, from: string, ts: number, self: boolean}) => void} fn */
export function onStroke(fn) { _strokeListeners.push(fn); }

/** @param {(msg: {from: string, ts: number, self: boolean}) => void} fn */
export function onClear(fn) { _clearListeners.push(fn); }

function _emitStatus(s)  { _statusListeners.forEach((fn) => fn(s)); }
function _emitMembers(n) { _memberListeners.forEach((fn) => fn(n)); }
function _emitChat(msg)  { _chatListeners.forEach((fn) => fn(msg)); }
function _emitStroke(msg){ _strokeListeners.forEach((fn) => fn(msg)); }
function _emitClear(msg) { _clearListeners.forEach((fn) => fn(msg)); }

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

    /* ---- Presence: member count ---- */
    _channel.on('presence', { event: 'sync' }, () => {
      const state = _channel.presenceState();
      _emitMembers(Object.keys(state).length);
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
  _channel  = null;
  _roomCode = null;
  _emitStatus('disconnected');
  _emitMembers(0);
}

/* ============================================================
 * Broadcast: Chat
 * ============================================================ */

export async function sendChat(text) {
  if (!_channel) throw new Error('Belum terhubung ke room.');

  const payload = { text, from: getSelfKey(), ts: Date.now() };

  /* optimistic: show own message immediately */
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
 * @param {Array<{x: number, y: number}>} strokeData.points
 * @param {string} strokeData.color
 * @param {number} strokeData.size
 * @param {boolean} strokeData.isStart
 * @param {boolean} strokeData.isEnd
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
