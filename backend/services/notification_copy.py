# Push notification body copy — English + Romanian, matching
# frontend/js/i18n.js's exact two-language scope (see that file's own
# comment on why this app deliberately doesn't try to scale beyond en/ro).
# Kept as its own small module rather than folded into
# notification_scheduler.py so the "what does each notification actually
# say" question has one obvious place to answer, independent of the
# scheduling/eligibility logic around it.
#
# Deliberately warm, encouraging copy with a little personality (emoji,
# exclamation points) — this is the one place in the backend that talks
# directly to a user in a moment they didn't ask for (unlike every other
# response, which is a reply to a request they just made), so it has to
# earn its interruption rather than read like a system alert.
_COPY = {
    "en": {
        "daily_reminder": (
            "Iron Log",
            "👋 Don't forget to log today's meals — every entry keeps you one step closer to your goals!",
        ),
        "food_nudge": (
            "Iron Log",
            "🍽️ No meals logged yet today — a quick log now keeps your momentum going!",
        ),
        "water_nudge": (
            "Iron Log",
            "💧 Stay hydrated! You're a bit behind on water today — a glass now helps you feel your best.",
        ),
        "weekly_recap_with_logs": (
            "🎉 Your Weekly Recap",
            "This week you stayed on target {adherent}/{logged} logged days — nice work! Open Iron Log to see the full picture.",
        ),
        "weekly_recap_no_logs": (
            "📊 Your Weekly Recap",
            "No meals logged this week — a brand new week starts tomorrow. You've got this!",
        ),
        "test": (
            "Iron Log",
            "✅ Test notification — if you can see this, push is working perfectly!",
        ),
    },
    "ro": {
        "daily_reminder": (
            "Iron Log",
            "👋 Nu uita să înregistrezi mesele de azi — fiecare notare te aduce cu un pas mai aproape de obiectivele tale!",
        ),
        "food_nudge": (
            "Iron Log",
            "🍽️ Încă nu ai înregistrat nicio masă azi — o notare rapidă acum îți menține ritmul!",
        ),
        "water_nudge": (
            "Iron Log",
            "💧 Hidratează-te! Ești puțin în urmă cu apa azi — un pahar acum te ajută să te simți grozav.",
        ),
        "weekly_recap_with_logs": (
            "🎉 Recapitularea săptămânii tale",
            "Săptămâna asta ai fost în limită {adherent}/{logged} zile înregistrate — bravo! Deschide Iron Log pentru imaginea completă.",
        ),
        "weekly_recap_no_logs": (
            "📊 Recapitularea săptămânii tale",
            "Nicio masă înregistrată săptămâna asta — o săptămână nouă începe mâine. Poți reuși!",
        ),
        "test": (
            "Iron Log",
            "✅ Notificare de test — dacă vezi asta, notificările push funcționează perfect!",
        ),
    },
}


def notification_text(language: str, key: str, **format_args) -> tuple[str, str]:
    """(title, body) in the given language, formatted with format_args (used
    only by the weekly-recap keys' {adherent}/{logged} placeholders). Falls
    back to English for an unrecognized language string — same defensive
    "never let a bad stored value break a background sweep" posture as
    notification_service.parse_hhmm's fallback."""
    entry = _COPY.get(language, _COPY["en"]).get(key) or _COPY["en"][key]
    title, body = entry
    return title, body.format(**format_args)
