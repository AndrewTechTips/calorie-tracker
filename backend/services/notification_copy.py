# Push notification body copy — English + Romanian, matching
# frontend/js/i18n.js's exact two-language scope (see that file's own
# comment on why this app deliberately doesn't try to scale beyond en/ro).
# Kept as its own small module rather than folded into
# notification_scheduler.py so the "what does each notification actually
# say" question has one obvious place to answer, independent of the
# scheduling/eligibility logic around it.
#
# Deliberately clean, concise, and professional — no emoji, no exclamation
# points, no filler ("Don't forget!", "You've got this!"). This is the one
# place in the backend that talks directly to a user in a moment they
# didn't ask for, so it should read like a premium product nudging someone
# with respect for their attention, not like an app shouting for it.
_COPY = {
    "en": {
        "daily_reminder": (
            "Iron Log",
            "Log today's meals to stay on track with your goals.",
        ),
        "food_nudge": (
            "Iron Log",
            "No meals logged yet today. Log now to keep your streak going.",
        ),
        "water_nudge": (
            "Iron Log",
            "You're behind on water today. A glass now will help you catch up.",
        ),
        "weekly_recap_with_logs": (
            "Weekly Recap",
            "On target {adherent}/{logged} logged days this week. Open Iron Log for the full picture.",
        ),
        "weekly_recap_no_logs": (
            "Weekly Recap",
            "No meals logged this week. A new week starts tomorrow.",
        ),
        "test": (
            "Iron Log",
            "Test notification — push is working correctly.",
        ),
    },
    "ro": {
        "daily_reminder": (
            "Iron Log",
            "Înregistrează mesele de azi ca să rămâi pe drumul cel bun spre obiectivele tale.",
        ),
        "food_nudge": (
            "Iron Log",
            "Încă nu ai înregistrat nicio masă azi. Notează acum ca să îți menții ritmul.",
        ),
        "water_nudge": (
            "Iron Log",
            "Ești în urmă cu hidratarea azi. Un pahar de apă acum te ajută să recuperezi.",
        ),
        "weekly_recap_with_logs": (
            "Recapitulare săptămânală",
            "În limita țintei {adherent}/{logged} zile înregistrate săptămâna aceasta. Deschide Iron Log pentru imaginea completă.",
        ),
        "weekly_recap_no_logs": (
            "Recapitulare săptămânală",
            "Nicio masă înregistrată săptămâna aceasta. O săptămână nouă începe mâine.",
        ),
        "test": (
            "Iron Log",
            "Notificare de test — notificările push funcționează corect.",
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
