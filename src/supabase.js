/**
 * src/supabase.js — Supabase client singleton
 *
 * Reads credentials from Vite env variables so the real keys are
 * never committed to the repository.
 * Supports:
 *   - VITE_SUPABASE_URL / SUPABASE_URL
 *   - VITE_SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.SUPABASE_URL;

const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    '[supabase] Kredensial belum lengkap. Pastikan .env memiliki VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY (atau SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY).'
  );
}

export const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;
