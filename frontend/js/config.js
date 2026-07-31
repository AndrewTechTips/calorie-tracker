// Fill these in with your own project values. None of these are secret in the
// sense of needing to be hidden from the browser — the Supabase anon key is
// designed to be public (Row Level Security is what protects data), and the
// API base URL is just where your Render-deployed backend lives.

export const SUPABASE_URL = "https://mjtyizbodcidzmdossde.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable__21TosC3ULK5VvLmXR6UnQ_M_zKgrOE";

// Deployed value — this is what ships to GitHub Pages. For local dev against
// a backend running on your own machine, temporarily swap this to
// "http://localhost:8000" and change it back before committing (no build
// step here to do this automatically per-environment).
export const API_BASE_URL = "http://localhost:8000" ;

// Cloudflare Turnstile site key (public — safe to embed, same trust level as
// the Supabase anon key above). Leave blank to keep signup CAPTCHA-free
// exactly as before; the widget only appears once this is set. Requires two
// manual, one-time setup steps this code can't do for you: (1) create a free
// site at https://dash.cloudflare.com/?to=/:account/turnstile and paste its
// site key here, (2) enable Turnstile as the CAPTCHA provider in your
// Supabase project's Authentication → Attack Protection settings with the
// matching *secret* key (that secret never goes in frontend code).
export const TURNSTILE_SITE_KEY = "";
