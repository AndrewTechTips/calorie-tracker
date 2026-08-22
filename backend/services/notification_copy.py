import random

# Push notification body copy — English + Romanian, matching
# frontend/js/i18n.js's exact two-language scope (see that file's own
# comment on why this app deliberately doesn't try to scale beyond en/ro).
# Kept as its own small module rather than folded into
# notification_scheduler.py so the "what does each notification actually
# say" question has one obvious place to answer, independent of the
# scheduling/eligibility logic around it.
#
# Voiced as Ollie, the app's 3D companion (see frontend/js/ollie3d.js /
# petHud.js), first person — this is the one place the backend talks
# directly to a user in a moment they didn't ask for, so it reads like a
# companion who noticed something, not a system alert: warm and premium,
# never cheesy or emoji-heavy. Each key holds a short list of phrasings
# rather than one fixed line so the same nudge doesn't read identically
# every time it fires (particularly interval-mode reminders, which can
# repeat several times a day) — notification_text() below picks one at
# random per send.
_COPY = {
    "en": {
        "daily_reminder": [
            ("Ollie", "I haven't seen today's meals yet — let's log them and stay on track together."),
            ("Ollie", "Quick check-in: how did today's meals go? Log them when you get a moment."),
            ("Ollie", "Haven't heard from you today. I'll be here whenever you're ready to log."),
        ],
        "food_nudge": [
            ("Ollie", "Still waiting on today's first meal — a quick log keeps our streak alive."),
            ("Ollie", "No food logged yet today. Let's not lose the streak we've built."),
            ("Ollie", "I noticed today's still empty — log something now and we're back on track."),
        ],
        "water_nudge": [
            ("Ollie", "I'm getting a bit thirsty — let's log some water."),
            ("Ollie", "You're behind on water today. A glass now helps us catch up."),
            ("Ollie", "Water's lagging today. Even a small glass logged now makes a difference."),
        ],
        "weekly_recap_with_logs": [
            ("Ollie's Weekly Recap", "On target {adherent}/{logged} days this week — solid work. Open Iron Log for the full picture."),
            ("Ollie's Weekly Recap", "{adherent} of {logged} days on target this week. I'm proud of the progress — let's keep it going."),
        ],
        "weekly_recap_no_logs": [
            ("Ollie's Weekly Recap", "No meals logged this week. I missed you — let's start fresh tomorrow."),
            ("Ollie's Weekly Recap", "A quiet week with no logs. A new one starts tomorrow, and I'll be here."),
        ],
        "test": [
            ("Iron Log", "Test notification — push is working correctly."),
        ],
    },
    "ro": {
        "daily_reminder": [
            ("Ollie", "Încă n-am văzut mesele de azi — hai să le notăm și să rămânem pe drumul cel bun."),
            ("Ollie", "O verificare rapidă: cum au fost mesele de azi? Notează-le când ai un moment."),
            ("Ollie", "N-am nicio veste de la tine azi. Sunt aici oricând ești gata să notezi."),
        ],
        "food_nudge": [
            ("Ollie", "Încă aștept prima masă de azi — o notare rapidă ne ține ritmul viu."),
            ("Ollie", "Nicio masă înregistrată azi încă. Să nu pierdem ritmul pe care l-am construit."),
            ("Ollie", "Am observat că azi e încă gol — notează ceva acum și revenim pe drum."),
        ],
        "water_nudge": [
            ("Ollie", "Mi-e cam sete — hai să notăm puțină apă."),
            ("Ollie", "Ești în urmă cu hidratarea azi. Un pahar acum ne ajută să recuperăm."),
            ("Ollie", "Hidratarea e în urmă azi. Chiar și un pahar mic notat acum contează."),
        ],
        "weekly_recap_with_logs": [
            ("Recapitularea lui Ollie", "În limita țintei {adherent}/{logged} zile săptămâna aceasta — treabă solidă. Deschide Iron Log pentru imaginea completă."),
            ("Recapitularea lui Ollie", "{adherent} din {logged} zile în limita țintei săptămâna aceasta. Sunt mândru de progres — să continuăm așa."),
        ],
        "weekly_recap_no_logs": [
            ("Recapitularea lui Ollie", "Nicio masă înregistrată săptămâna aceasta. Mi-a fost dor de tine — hai să începem cu dreptul mâine."),
            ("Recapitularea lui Ollie", "O săptămână liniștită, fără notări. Una nouă începe mâine, și voi fi aici."),
        ],
        "test": [
            ("Iron Log", "Notificare de test — notificările push funcționează corect."),
        ],
    },
}


def notification_text(language: str, key: str, **format_args) -> tuple[str, str]:
    """(title, body) in the given language, formatted with format_args (used
    only by the weekly-recap keys' {adherent}/{logged} placeholders). Falls
    back to English for an unrecognized language string — same defensive
    "never let a bad stored value break a background sweep" posture as
    notification_service.parse_hhmm's fallback. Picks one variation at
    random from `key`'s list each call, so a repeating nudge (e.g.
    interval-mode daily reminders) doesn't read identically every time."""
    variations = _COPY.get(language, _COPY["en"]).get(key) or _COPY["en"][key]
    title, body = random.choice(variations)
    return title, body.format(**format_args)
