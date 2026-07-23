import os

# Settings() requires these to be present (no defaults, by design — see
# config.py) even though nothing in this test suite ever makes a real
# network call to Supabase or Gemini. Must be set before any backend module
# is imported anywhere in the test session.
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
