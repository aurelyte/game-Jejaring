/**
 * src/room.js — Room lifecycle: create, join, leave
 *
 * Fase 2a: Supabase Realtime channel per room.
 * Belum ada transfer data gambar/guess — fokus ke presence channel
 * dan status koneksi saja.
 *
 * Public API:
 *   joinRoom(roomCode)  → subscribes, returns channel
 *   leaveRoom()         → unsubscribes current channel
 *   onStatusChange(fn)  → register status callback
 *   onMemberChange(fn)  → register member-count callback
 *   currentRoom()       → room code string | null
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

/* ============================================================
 * Listener registration
 * ============================================================ */

/**
 * onStatusChange - Register a callback invoked on connection state changes.
 *
 * Possible status strings passed to the callback:
 *   'connecting' | 'connected' | 'disconnected' | 'error'
 *
 * @param {(status: string) => void} fn
 */
export function onStatusChange(fn) {
  _statusListeners.push(fn);
}

/**
 * onMemberChange - Register a callback invoked when room member count changes.
 *
 * @param {(count: number) => void} fn
 */
export function onMemberChange(fn) {
  _memberListeners.push(fn);
}

function _emitStatus(status)  { _statusListeners.forEach((fn) => fn(status)); }
function _emitMembers(count)  { _memberListeners.forEach((fn) => fn(count));  }

/* ============================================================
 * Room helpers
 * ============================================================ */

/**
 * generateRoomCode - Return a random 6-character alphanumeric code.
 *
 * Uses uppercase letters + digits; excludes ambiguous chars (0/O, 1/I/L)
 * so codes are easy to read aloud or type on mobile.
 *
 * @returns {string}
 */
export function generateRoomCode() {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/** currentRoom - Return the active room code, or null if not in a room. */
export function currentRoom() {
  return _roomCode;
}

/* ============================================================
 * Join / leave
 * ============================================================ */

/**
 * joinRoom - Subscribe to a Supabase Realtime Presence channel.
 *
 * Channel name: `room:{roomCode}` (e.g. "room:AB3X7Q").
 * Presence is used so each tab knows how many peers share the room.
 *
 * Steps:
 *   1. Leave any existing channel.
 *   2. Create a new Presence channel for the room.
 *   3. Subscribe; on SUBSCRIBED emit 'connected' and track presence.
 *   4. Listen to presence sync events to maintain member count.
 *
 * @param {string} roomCode
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
export async function joinRoom(roomCode) {
  /* normalise: uppercase, strip whitespace */
  const code = roomCode.trim().toUpperCase();

  /* leave previous room if any */
  await leaveRoom();

  _roomCode = code;
  _emitStatus('connecting');

  _channel = supabase.channel(`room:${code}`, {
    config: { presence: { key: _selfKey() } },
  });

  /* Presence sync → update member count */
  _channel.on('presence', { event: 'sync' }, () => {
    const state = _channel.presenceState();
    _emitMembers(Object.keys(state).length);
  });

  /* Subscribe and handle connection state */
  _channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      _emitStatus('connected');
      /* announce ourselves in the presence map */
      await _channel.track({ joined_at: Date.now() });
    } else if (status === 'CHANNEL_ERROR') {
      _emitStatus('error');
    } else if (status === 'TIMED_OUT' || status === 'CLOSED') {
      _emitStatus('disconnected');
    }
  });

  return _channel;
}

/**
 * leaveRoom - Untrack presence and unsubscribe from the current channel.
 *
 * Safe to call when not in a room (no-op).
 */
export async function leaveRoom() {
  if (!_channel) return;

  try {
    await _channel.untrack();
    await supabase.removeChannel(_channel);
  } catch (_) {
    /* ignore errors on cleanup */
  }

  _channel  = null;
  _roomCode = null;
  _emitStatus('disconnected');
  _emitMembers(0);
}

/* ============================================================
 * Internal helpers
 * ============================================================ */

/**
 * _selfKey - Stable random key for this browser tab's presence entry.
 *
 * Generated once per module load so refreshing re-uses the same key
 * within the same session (stored in sessionStorage).
 *
 * @returns {string}
 */
function _selfKey() {
  const STORAGE_KEY = 'tebak-gambar:presence-key';
  let key = sessionStorage.getItem(STORAGE_KEY);
  if (!key) {
    key = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(STORAGE_KEY, key);
  }
  return key;
}
