/**
 * tests/scoring-leaderboard.test.js
 *
 * Verifikasi Sistem Skor & Leaderboard (Fase 5a):
 * 1. Host authoritative score calculation (faster guess = higher score).
 * 2. Leaderboard sorting & ranking logic.
 * 3. Realtime broadcast 'score-update' synchronization across clients.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Baca .env
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

console.log('--- TEST 1: Host Scoring Calculation (Speed Scaling) ---');
function calculateGuessScore(secondsRemaining, turnDuration = 60) {
  const basePoints = 100;
  const ratio = Math.max(0, Math.min(1, Number(secondsRemaining) / (turnDuration || 60)));
  const speedBonus = Math.round(ratio * 400);
  const guesserPoints = basePoints + speedBonus;
  const drawerPoints = Math.round(guesserPoints * 0.5);
  return { guesserPoints, drawerPoints, speedBonus };
}

const fastScore = calculateGuessScore(55, 60);
const midScore  = calculateGuessScore(30, 60);
const slowScore = calculateGuessScore(5, 60);

console.log('Fast guess (55s remaining):', fastScore);
console.log('Mid guess (30s remaining):', midScore);
console.log('Slow guess (5s remaining):', slowScore);

if (fastScore.guesserPoints <= midScore.guesserPoints || midScore.guesserPoints <= slowScore.guesserPoints) {
  console.error('FAIL: Score does not scale with speed!');
  process.exit(1);
}
if (fastScore.guesserPoints < 400 || slowScore.guesserPoints > 200) {
  console.error('FAIL: Expected point ranges breached!');
  process.exit(1);
}
console.log('PASS: Faster guesses yield strictly higher scores.\n');

console.log('--- TEST 2: Leaderboard Sorting & Ranking ---');
function buildLeaderboardList(players, scoresMap) {
  const list = players.map(p => ({
    id: p.id,
    name: p.name,
    score: Number(scoresMap[p.id] || 0),
  }));

  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return list.map((item, idx) => ({ ...item, rank: idx + 1 }));
}

const mockPlayers = [
  { id: 'p1', name: 'Zenn' },
  { id: 'p2', name: 'Alice' },
  { id: 'p3', name: 'Bob' },
];

const mockScores = {
  p1: 250,
  p2: 480, // Rank 1
  p3: 150, // Rank 3
};

const leaderboard = buildLeaderboardList(mockPlayers, mockScores);
console.log('Calculated Leaderboard:', leaderboard);

if (leaderboard[0].id !== 'p2' || leaderboard[0].rank !== 1) {
  console.error('FAIL: Rank 1 is not Alice!');
  process.exit(1);
}
if (leaderboard[1].id !== 'p1' || leaderboard[1].rank !== 2) {
  console.error('FAIL: Rank 2 is not Zenn!');
  process.exit(1);
}
if (leaderboard[2].id !== 'p3' || leaderboard[2].rank !== 3) {
  console.error('FAIL: Rank 3 is not Bob!');
  process.exit(1);
}
console.log('PASS: Leaderboard correctly sorted by score descending.\n');

console.log('--- TEST 3: Realtime Broadcast "score-update" Synchronization ---');
(async () => {
  const roomCode = 'SCOR' + Math.random().toString(36).slice(2, 4).toUpperCase();
  console.log(`Target Test Room Code: ${roomCode}`);

  const clientHost = createClient(supabaseUrl, supabaseAnonKey);
  const clientPeer = createClient(supabaseUrl, supabaseAnonKey);

  const hostChannel = clientHost.channel(`room:${roomCode}`, {
    config: { presence: { key: 'host_player' } },
  });
  const peerChannel = clientPeer.channel(`room:${roomCode}`, {
    config: { presence: { key: 'peer_player' } },
  });

  let peerReceivedScore = null;

  peerChannel.on('broadcast', { event: 'score-update' }, ({ payload }) => {
    peerReceivedScore = payload;
  });

  await new Promise((res) => {
    hostChannel.subscribe((s) => {
      if (s === 'SUBSCRIBED') res();
    });
  });

  await new Promise((res) => {
    peerChannel.subscribe((s) => {
      if (s === 'SUBSCRIBED') res();
    });
  });

  await new Promise((r) => setTimeout(r, 600));

  // Host broadcasts score update
  const payloadToSend = {
    scores: { host_player: 150, peer_player: 480 },
    leaderboard: [
      { id: 'peer_player', name: 'Peer', score: 480, rank: 1 },
      { id: 'host_player', name: 'Host', score: 150, rank: 2 },
    ],
    lastAward: {
      guesserId: 'peer_player',
      guesserName: 'Peer',
      guesserPoints: 480,
      drawerId: 'host_player',
      drawerPoints: 240,
      secondsRemaining: 55,
    },
  };

  await hostChannel.send({
    type: 'broadcast',
    event: 'score-update',
    payload: {
      ...payloadToSend,
      from: 'host_player',
      ts: Date.now(),
    },
  });

  await new Promise((r) => setTimeout(r, 1200));

  if (!peerReceivedScore) {
    console.error('FAIL: Peer client did not receive score-update broadcast!');
    process.exit(1);
  }

  console.log('Peer received score update payload:');
  console.log('  Leaderboard Rank 1:', peerReceivedScore.leaderboard[0]);
  console.log('  Last Award:', peerReceivedScore.lastAward);

  if (peerReceivedScore.leaderboard[0].score !== 480 || peerReceivedScore.lastAward.guesserPoints !== 480) {
    console.error('FAIL: Broadcasted score mismatch!');
    process.exit(1);
  }

  console.log('PASS: Realtime score-update broadcast verified across clients.\n');

  await hostChannel.unsubscribe();
  await peerChannel.unsubscribe();

  console.log('ALL SCORING & LEADERBOARD TESTS PASSED SUCCESSFULLY! 🚀');
  process.exit(0);
})();
