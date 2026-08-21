import os

# Settings() requires these to be present (no defaults, by design — see
# config.py) even though nothing in this test suite ever makes a real
# network call to Supabase or Gemini. Must be set before any backend module
# is imported anywhere in the test session.
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
# nutrition_db_service.lookup() hits Open Food Facts with no API key
# required at all — unlike every other external call in this app, there's
# no "blank key -> skipped" gate to rely on for it. Disabled by default here
# so the wider test suite (which calls _finalize_ingredients/
# estimate_macros_for_food_name incidentally, not to test grounding itself)
# never makes a real network call. tests/test_nutrition_db_service.py
# explicitly re-enables it per-test where it mocks the HTTP layer instead.
os.environ.setdefault("NUTRITION_DB_GROUNDING_ENABLED", "false")
