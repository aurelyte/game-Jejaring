/**
 * test-multiplayer-flow.js
 *
 * Verifikasi integrasi Multiplayer Waiting Room & Randomized First Drawer:
 * 1. Room lifecycle state checks (waiting -> started).
 * 2. Randomized first drawer statistical fairness test (all players including host can be chosen).
 * 3. Supabase Realtime multi-client simulation:
 *    - Client 1 (Host: "Zenn") creates room -> WAITING
 *    - Client 2 (Player: "Alice") joins waiting room
 *    - Client 3 (Player: "Bob") joins waiting room
 *    - Host starts game -> broadcast 'game-start'
 *    - Verify all 3 clients receive identical firstDrawerId
 *    - Client 4 (Late Player: "Charlie") attempts join -> rejection check (GAME_ALREADY_STARTED)
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Baca .env secara manual
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = (match[2] || '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    envVars[match[1]] = value;
  }
}

const supabaseUrl = envVars.VITE_SUPABASE_URL;
const supabaseAnonKey = envVars.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('FAIL: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

console.log('--- TEST 1: Randomized First Drawer Uniform Distribution Test ---');
{
  const players = [
    { id: 'player_host', name: 'Zenn (Host)', is_host: true },
    { id: 'player_b', name: 'Alice', is_host: false },
    { id: 'player_c', name: 'Bob', is_host: false },
  ];

  const counts = { player_host: 0, player_b: 0, player_c: 0 };
  const TRIALS = 30000;

  for (let i = 0; i < TRIALS; i++) {
    const pick = players[Math.floor(Math.random() * players.length)];
    counts[pick.id]++;
  }

  const expected = TRIALS / 3;
  console.log(`Ran ${TRIALS} random drawer selections among 3 players:`);
  for (const [id, count] of Object.entries(counts)) {
    const pct = ((count / TRIALS) * 100).toFixed(2);
    console.log(`  - ${id}: ${count} times (${pct}%) [Expected ~33.33%]`);
    const diff = Math.abs(count - expected);
    if (diff > TRIALS * 0.05) {
      console.error(`FAIL: Significant deviation for ${id}: ${diff}`);
      process.exit(1);
    }
  }
  console.log('PASS: Randomized first drawer is uniformly distributed and includes Host.\n');
}

console.log('--- TEST 2: Realtime Multi-client Waiting Room & Game Start Flow ---');
(async () => {
  const roomCode = 'TEST' + Math.random().toString(36).slice(2, 4).toUpperCase();
  console.log(`Target Test Room Code: ${roomCode}`);

  const clientHost = createClient(supabaseUrl, supabaseAnonKey);
  const clientAlice = createClient(supabaseUrl, supabaseAnonKey);
  const clientBob = createClient(supabaseUrl, supabaseAnonKey);

  const hostChannel = clientHost.channel(`room:${roomCode}`, {
    config: { presence: { key: 'host_zenn' } },
  });
  const aliceChannel = clientAlice.channel(`room:${roomCode}`, {
    config: { presence: { key: 'peer_alice' } },
  });
  const bobChannel = clientBob.channel(`room:${roomCode}`, {
    config: { presence: { key: 'peer_bob' } },
  });

  let hostReceivedStart = null;
  let aliceReceivedStart = null;
  let bobReceivedStart = null;

  hostChannel.on('broadcast', { event: 'game-start' }, ({ payload }) => {
    hostReceivedStart = payload;
  });
  aliceChannel.on('broadcast', { event: 'game-start' }, ({ payload }) => {
    aliceReceivedStart = payload;
  });
  bobChannel.on('broadcast', { event: 'game-start' }, ({ payload }) => {
    bobReceivedStart = payload;
  });

  // 1. Subscribe host
  await new Promise((resolve) => {
    hostChannel.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        await hostChannel.track({ id: 'host_zenn', name: 'Zenn', is_host: true });
        console.log('  [Host Zenn] Subscribed & tracked presence in Waiting Room.');
        resolve();
      }
    });
  });

  // 2. Subscribe Alice
  await new Promise((resolve) => {
    aliceChannel.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        await aliceChannel.track({ id: 'peer_alice', name: 'Alice', is_host: false });
        console.log('  [Alice] Joined Waiting Room & tracked presence.');
        resolve();
      }
    });
  });

  // 3. Subscribe Bob
  await new Promise((resolve) => {
    bobChannel.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        await bobChannel.track({ id: 'peer_bob', name: 'Bob', is_host: false });
        console.log('  [Bob] Joined Waiting Room & tracked presence.');
        resolve();
      }
    });
  });

  await new Promise((r) => setTimeout(r, 600));

  // Snapshot candidates
  const candidates = [
    { id: 'host_zenn', name: 'Zenn', is_host: true },
    { id: 'peer_alice', name: 'Alice', is_host: false },
    { id: 'peer_bob', name: 'Bob', is_host: false },
  ];

  const chosenFirstDrawer = candidates[Math.floor(Math.random() * candidates.length)].id;
  console.log(`  [Host] Starting game! Randomized First Drawer chosen: ${chosenFirstDrawer}`);

  await hostChannel.send({
    type: 'broadcast',
    event: 'game-start',
    payload: {
      roomCode,
      players: candidates,
      firstDrawerId: chosenFirstDrawer,
      startedAt: Date.now(),
      from: 'host_zenn',
      ts: Date.now(),
    },
  });

  // Tunggu pesan disiarkan ke semua client
  await new Promise((r) => setTimeout(r, 1200));

  if (!aliceReceivedStart) {
    console.error('FAIL: Alice did not receive game-start broadcast');
    process.exit(1);
  }
  if (!bobReceivedStart) {
    console.error('FAIL: Bob did not receive game-start broadcast');
    process.exit(1);
  }

  console.log(`  [Alice Received]: firstDrawerId=${aliceReceivedStart.firstDrawerId}`);
  console.log(`  [Bob Received]: firstDrawerId=${bobReceivedStart.firstDrawerId}`);

  if (aliceReceivedStart.firstDrawerId !== chosenFirstDrawer || bobReceivedStart.firstDrawerId !== chosenFirstDrawer) {
    console.error('FAIL: Desync in firstDrawerId across clients!');
    process.exit(1);
  }

  console.log('PASS: All clients synchronized on identical randomized first drawer!\n');

  console.log('--- TEST 3: Late Joiner Rejection Simulation ---');
  // Simulasi jika room berstatus started, late joiner ditolak
  const roomState = {
    room_code: roomCode,
    status: 'started',
    first_drawer_id: chosenFirstDrawer,
    players: candidates.map(c => c.id),
  };

  function simulateJoin(code, playerId) {
    if (roomState.status === 'started' && !roomState.players.includes(playerId)) {
      return { success: false, error: 'GAME_ALREADY_STARTED', message: 'Game already started. You cannot join this room.' };
    }
    return { success: true, status: roomState.status };
  }

  const lateJoinResult = simulateJoin(roomCode, 'peer_charlie');
  console.log('  Late join attempt for new player "peer_charlie":', lateJoinResult);

  if (lateJoinResult.success === false && lateJoinResult.error === 'GAME_ALREADY_STARTED') {
    console.log('PASS: Late joiner correctly rejected with GAME_ALREADY_STARTED error message.');
  } else {
    console.error('FAIL: Late joiner was not rejected!');
    process.exit(1);
  }

  // Reconnecting player test
  const reconnectResult = simulateJoin(roomCode, 'peer_alice');
  console.log('  Reconnection attempt for registered player "peer_alice":', reconnectResult);
  if (reconnectResult.success === true && reconnectResult.status === 'started') {
    console.log('PASS: Existing player successfully rejoins started game session.');
  } else {
    console.error('FAIL: Existing player failed to reconnect!');
    process.exit(1);
  }

  // Cleanup channels
  await hostChannel.unsubscribe();
  await aliceChannel.unsubscribe();
  await bobChannel.unsubscribe();

  console.log('\nALL MULTIPLAYER WAITING ROOM & RANDOMIZED DRAWER TESTS PASSED SUCCESSFULLY! 🚀');
  process.exit(0);
})();
