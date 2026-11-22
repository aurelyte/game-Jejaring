-- ====================================================================
-- Migration: 20261122_waiting_room.sql
-- Description: Multiplayer Waiting Room, Host Authority, Room Lifecycle
--              (waiting -> started -> finished), and Randomized First Drawer
-- ====================================================================

-- 1. Tabel rooms
CREATE TABLE IF NOT EXISTS public.rooms (
  room_code       TEXT PRIMARY KEY,
  host_player_id  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'started', 'finished')),
  first_drawer_id TEXT,
  started_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  max_players     INT NOT NULL DEFAULT 8
);

-- 2. Tabel room_players
CREATE TABLE IF NOT EXISTS public.room_players (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES public.rooms(room_code) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  player_name TEXT NOT NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_room_player UNIQUE (room_code, player_id)
);

CREATE INDEX IF NOT EXISTS idx_room_players_room ON public.room_players(room_code);

-- 3. Row Level Security (RLS)
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

-- Izinkan read untuk anon / authenticated
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Allow public read rooms'
  ) THEN
    CREATE POLICY "Allow public read rooms" ON public.rooms FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'room_players' AND policyname = 'Allow public read room_players'
  ) THEN
    CREATE POLICY "Allow public read room_players" ON public.room_players FOR SELECT USING (true);
  END IF;
END $$;


-- ====================================================================
-- RPC 1: create_room_rpc
-- Membuat room baru dengan status 'waiting' dan mendaftarkan host sebagai anggota pertama
-- ====================================================================
CREATE OR REPLACE FUNCTION public.create_room_rpc(
  p_room_code TEXT,
  p_host_player_id TEXT,
  p_host_player_name TEXT,
  p_max_players INT DEFAULT 8
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_code TEXT := UPPER(TRIM(p_room_code));
  v_host_name TEXT := TRIM(p_host_player_name);
BEGIN
  IF v_host_name IS NULL OR v_host_name = '' THEN
    v_host_name := 'Host';
  END IF;

  -- Jika room code sudah ada dan aktif, tolak duplikasi
  IF EXISTS (SELECT 1 FROM public.rooms WHERE room_code = v_room_code AND status <> 'finished') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_ALREADY_EXISTS',
      'message', 'Kode room sudah digunakan. Silakan buat room baru.'
    );
  END IF;

  -- Hapus room lama jika sudah finished dengan kode yang sama
  DELETE FROM public.rooms WHERE room_code = v_room_code;

  -- Insert room baru
  INSERT INTO public.rooms (room_code, host_player_id, status, max_players, created_at)
  VALUES (v_room_code, p_host_player_id, 'waiting', COALESCE(p_max_players, 8), NOW());

  -- Insert host sebagai player pertama
  INSERT INTO public.room_players (room_code, player_id, player_name, joined_at)
  VALUES (v_room_code, p_host_player_id, v_host_name, NOW());

  RETURN jsonb_build_object(
    'success', true,
    'room_code', v_room_code,
    'host_player_id', p_host_player_id,
    'status', 'waiting'
  );
END;
$$;


-- ====================================================================
-- RPC 2: join_room_rpc (Transactional lock via SELECT ... FOR UPDATE)
-- Mencegah race condition ketika pemain mencoba join bersamaan saat host menekan Start
-- ====================================================================
CREATE OR REPLACE FUNCTION public.join_room_rpc(
  p_room_code TEXT,
  p_player_id TEXT,
  p_player_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_code TEXT := UPPER(TRIM(p_room_code));
  v_player_name TEXT := TRIM(p_player_name);
  v_room RECORD;
  v_player_count INT;
  v_is_existing BOOLEAN;
BEGIN
  IF v_player_name IS NULL OR v_player_name = '' THEN
    v_player_name := 'Pemain';
  END IF;

  -- LOCK row room untuk mencegah race condition dengan start_room
  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_room_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_NOT_FOUND',
      'message', 'Room tidak ditemukan. Periksa kembali kode room.'
    );
  END IF;

  -- Cek apakah player sudah terdaftar di room ini sebelumnya (reconnecting)
  SELECT EXISTS (
    SELECT 1 FROM public.room_players
    WHERE room_code = v_room_code AND player_id = p_player_id
  ) INTO v_is_existing;

  -- Jika pemain lama melakukan reconnect, izinkan masuk (baik status waiting maupun started)
  IF v_is_existing THEN
    UPDATE public.room_players
    SET player_name = v_player_name
    WHERE room_code = v_room_code AND player_id = p_player_id;

    RETURN jsonb_build_object(
      'success', true,
      'reconnected', true,
      'room_code', v_room_code,
      'status', v_room.status,
      'host_player_id', v_room.host_player_id,
      'first_drawer_id', v_room.first_drawer_id,
      'started_at', v_room.started_at
    );
  END IF;

  -- Pemain baru: tolak jika game sudah dimulai atau selesai
  IF v_room.status <> 'waiting' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'GAME_ALREADY_STARTED',
      'message', 'Game already started. You cannot join this room.'
    );
  END IF;

  -- Cek batas kapasitas pemain
  SELECT COUNT(*) INTO v_player_count
  FROM public.room_players
  WHERE room_code = v_room_code;

  IF v_player_count >= v_room.max_players THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_FULL',
      'message', 'Room sudah penuh (maksimal ' || v_room.max_players || ' pemain).'
    );
  END IF;

  -- Daftarkan pemain baru
  INSERT INTO public.room_players (room_code, player_id, player_name, joined_at)
  VALUES (v_room_code, p_player_id, v_player_name, NOW());

  RETURN jsonb_build_object(
    'success', true,
    'reconnected', false,
    'room_code', v_room_code,
    'status', v_room.status,
    'host_player_id', v_room.host_player_id
  );
END;
$$;


-- ====================================================================
-- RPC 3: start_room_rpc (Transactional lock + Randomized First Drawer)
-- Hanya host yang berhak memanggil, mengunci row room, memilih 1 drawer acak
-- ====================================================================
CREATE OR REPLACE FUNCTION public.start_room_rpc(
  p_room_code TEXT,
  p_host_player_id TEXT,
  p_min_players INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_code TEXT := UPPER(TRIM(p_room_code));
  v_room RECORD;
  v_candidates TEXT[];
  v_players JSONB;
  v_first_drawer_id TEXT;
  v_random_idx INT;
  v_started_at TIMESTAMPTZ := NOW();
BEGIN
  -- LOCK row room secara eksklusif selama transaksi berlangsung
  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_room_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_NOT_FOUND',
      'message', 'Room tidak ditemukan.'
    );
  END IF;

  -- Validasi otoritas Host di level database
  IF v_room.host_player_id <> p_host_player_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'UNAUTHORIZED_HOST',
      'message', 'Hanya host yang memiliki otoritas untuk memulai game.'
    );
  END IF;

  -- Validasi status room (hanya boleh start satu kali dari status waiting)
  IF v_room.status <> 'waiting' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_ALREADY_STARTED',
      'message', 'Game sudah dimulai sebelumnya.'
    );
  END IF;

  -- Ambil snapshot seluruh pemain yang terdaftar di room_players
  SELECT ARRAY_AGG(player_id ORDER BY joined_at),
         JSONB_AGG(jsonb_build_object(
           'id', player_id,
           'name', player_name,
           'joined_at', joined_at,
           'is_host', (player_id = v_room.host_player_id)
         ) ORDER BY joined_at)
  INTO v_candidates, v_players
  FROM public.room_players
  WHERE room_code = v_room_code;

  IF v_candidates IS NULL OR array_length(v_candidates, 1) < COALESCE(p_min_players, 1) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'NOT_ENOUGH_PLAYERS',
      'message', 'Jumlah pemain belum memenuhi syarat minimal (' || COALESCE(p_min_players, 1) || ' pemain).'
    );
  END IF;

  -- RANDOMIZED FIRST DRAWER:
  -- Memilih satu kandidat secara seragam dari array kandidat (host ikut sebagai kandidat)
  v_random_idx := 1 + FLOOR(RANDOM() * array_length(v_candidates, 1))::INT;
  v_first_drawer_id := v_candidates[v_random_idx];

  -- Update status room menjadi 'started' dan rekam first_drawer_id
  UPDATE public.rooms
  SET status = 'started',
      first_drawer_id = v_first_drawer_id,
      started_at = v_started_at
  WHERE room_code = v_room_code;

  RETURN jsonb_build_object(
    'success', true,
    'room_code', v_room_code,
    'status', 'started',
    'first_drawer_id', v_first_drawer_id,
    'started_at', v_started_at,
    'players', v_players
  );
END;
$$;


-- ====================================================================
-- RPC 4: get_room_state_rpc
-- Mengambil state terkini room beserta daftar pemain
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_room_state_rpc(
  p_room_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_code TEXT := UPPER(TRIM(p_room_code));
  v_room RECORD;
  v_players JSONB;
BEGIN
  SELECT * INTO v_room
  FROM public.rooms
  WHERE room_code = v_room_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ROOM_NOT_FOUND',
      'message', 'Room tidak ditemukan.'
    );
  END IF;

  SELECT JSONB_AGG(jsonb_build_object(
    'id', player_id,
    'name', player_name,
    'joined_at', joined_at,
    'is_host', (player_id = v_room.host_player_id)
  ) ORDER BY joined_at)
  INTO v_players
  FROM public.room_players
  WHERE room_code = v_room_code;

  RETURN jsonb_build_object(
    'success', true,
    'room_code', v_room.room_code,
    'host_player_id', v_room.host_player_id,
    'status', v_room.status,
    'first_drawer_id', v_room.first_drawer_id,
    'started_at', v_room.started_at,
    'max_players', v_room.max_players,
    'players', COALESCE(v_players, '[]'::jsonb)
  );
END;
$$;


-- ====================================================================
-- RPC 5: leave_room_rpc
-- Menghapus player dari room_players saat meninggalkan room waiting
-- ====================================================================
CREATE OR REPLACE FUNCTION public.leave_room_rpc(
  p_room_code TEXT,
  p_player_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_code TEXT := UPPER(TRIM(p_room_code));
  v_room RECORD;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE room_code = v_room_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true);
  END IF;

  -- Hapus player
  DELETE FROM public.room_players
  WHERE room_code = v_room_code AND player_id = p_player_id;

  -- Jika host yang keluar dan room masih waiting, hapus seluruh room
  IF v_room.host_player_id = p_player_id AND v_room.status = 'waiting' THEN
    DELETE FROM public.rooms WHERE room_code = v_room_code;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;
