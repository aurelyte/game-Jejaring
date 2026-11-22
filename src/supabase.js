/**
 * src/supabase.js — Supabase client singleton
 *
 * Reads credentials from Vite env variables so the real keys are
 * never committed to the repository.  .env.example documents the
 * required variable names; the actual .env file is git-ignored.
 *
 * Usage:
 *   import { supabase } from './supabase.js';
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    '[supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.\n' +
    'Copy .env.example → .env and fill in your project credentials.',
  );
}

/**
 * supabase - Shared Supabase client instance.
 *
 * Re-use this single instance across all modules; never call
 * createClient() more than once per page load.
 */
export const supabase = createClient(supabaseUrl, supabaseKey);
