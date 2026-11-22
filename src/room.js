/**
 * src/room.js — Room lifecycle + broadcast
 *
 * Fase 2a: Supabase Realtime Presence channel per room.
 * Fase 2b: broadcast 'chat' events antar tab/browser di room yang sama.
 *
 * Public API:
 *   joinRoom(roomCode)         → Promise<channel>; resolves on SUBSCRIBED
 *   leaveRoom()                → unsubscribes + cleans up
 *   sendChat(text)             → broadcast {type:'chat', text, from, ts}
 *   onStatusChange(fn)         → 'connecting'|'connected'|'disconnected'|'error'
 *   onMemberChange(fn)         → number of presence keys in room
 *   onChatMessage(fn)          → {text, from, ts, self} on every chat event
 *   currentRoom()              → room code | null
 *   generateRoomCode()         → random 6-char code
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

/* ============================================================
 * Listener registration
 * ============================================================ */

/** @param {(status: string) => void} fn */
export function onStatusChange(fn) { _statusListeners.push(fn); }

/** @param {(count: number) => void} fn */
export function onMemberChange(fn) { _memberListeners.push(fn); }

/**
 * onChatMessage - Register a callback for incoming chat messages.
 *
 * The callback receives:
 *   text  {string}  — message body
 *   from  {string}  — sender's presence key (short random id)
 *   ts    {number}  — Unix ms timestamp
 *   self  {boolean} — true when this tab sent the message
 *
 * @param {(msg: {text: string, from: string, ts: number, self: boolean}) => void} fn
 */
export function onChatMessage(fn) { _chatListeners.push(fn); }

function _emitStatus(s)  { _statusListeners.forEach((fn) => fn(s)); }
function _emitMembers(n) { _memberListeners.forEach((fn) => fn(n)); }
function _emitChat(msg)  { _chatListeners.forEach((fn) => fn(msg)); }

/* ============================================================
 * Helpers
 * ============================================================ */

/**
 * generateRoomCode - Random 6-char code from unambiguous alphabet.
 *
 * Excludes 0/O, 1/I/L to ease mobile entry and voice sharing.
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
 * _selfKey - Stable per-tab random identifier stored in sessionStorage.
 *
 * Re-used as both the Presence key and the chat 'from' field so peers
 * can distinguish their own messages from others'.
 *
 * @returns {string}
 */
function _selfKey() {
  const K = 'tebak-gambar:presence-key';
  let k = sessionStorage.getItem(K);
  if (!k) { k = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(K, k); }
  return k;
}

/* ============================================================
 * Join
 * ============================================================ */

/**
 * joinRoom - Subscribe to a Supabase Realtime channel and return a
 * Promise that resolves only when the WebSocket is SUBSCRIBED.
 *
 * Fix vs fase 2a: previously joinRoom() returned a channel reference
 * immediately (before the WebSocket handshake completed), so
 * enterRoom() called showGame() while the canvas wrapper was still
 * hidden, making offsetWidth = 0 and collapsing the canvas to 0 px.
 *
 * Now the Promise rejects on CHANNEL_ERROR / TIMED_OUT so the lobby
 * can show a proper error message instead of silently breaking.
 *
 * @param {string} roomCode
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
export function joinRoom(roomCode) {
  const code = roomCode.trim().toUpperCase();

  return new Promise(async (resolve, reject) => {
    /* leave existing channel first */
    await leaveRoom();

    _roomCode = code;
    _emitStatus('connecting');

    _channel = supabase.channel(`room:${code}`, {
      config: { presence: { key: _selfKey() } },
    });

    /* ---- Presence: member count ---- */
    _channel.on('presence', { event: 'sync' }, () => {
      const state = _channel.presenceState();
      _emitMembers(Object.keys(state).length);
    });

    /* ---- Broadcast: chat messages ---- */
    _channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      _emitChat({
        text: payload.text,
        from: payload.from,
        ts:   payload.ts,
        self: payload.from === _selfKey(),
      });
    });

    /* ---- Subscribe → resolve/reject the Promise ---- */
    _channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        _emitStatus('connected');
        await _channel.track({ joined_at: Date.now() });
        resolve(_channel);                   /* ← Promise resolves HERE */
      } else if (status === 'CHANNEL_ERROR') {
        _emitStatus('error');
        reject(new Error('Channel error — periksa kredensial Supabase.'));
      } else if (status === 'TIMED_OUT') {
        _emitStatus('disconnected');
        reject(new Error('Koneksi timeout — coba lagi.'));
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
 * Safe to call when no room is active (no-op).
 */
export async function leaveRoom() {
  if (!_channel) return;
  try {
    await _channel.untrack();
    await supabase.removeChannel(_channel);
  } catch (_) { /* ignore cleanup errors */ }
  _channel  = null;
  _roomCode = null;
  _emitStatus('disconnected');
  _emitMembers(0);
}

/* ============================================================
 * Chat broadcast
 * ============================================================ */

/**
 * sendChat - Broadcast a chat message to all peers in the room.
 *
 * Uses channel.send() with type:'broadcast' and event:'chat'.
 * The sender also receives their own message via _emitChat so the
 * local UI updates immediately without waiting for the echo.
 *
 * @param {string} text — raw message text (caller should trim)
 * @returns {Promise<void>}
 */
export async function sendChat(text) {
  if (!_channel) throw new Error('Belum terhubung ke room.');

  const payload = { text, from: _selfKey(), ts: Date.now() };

  /* optimistic: show own message immediately */
  _emitChat({ ...payload, self: true });

  await _channel.send({
    type:    'broadcast',
    event:   'chat',
    payload,
  });
}
