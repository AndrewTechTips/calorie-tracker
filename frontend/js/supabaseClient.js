import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=20260821g";

// `supabase` is the global exposed by the CDN script tag loaded in index.html
// (https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2).
export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
