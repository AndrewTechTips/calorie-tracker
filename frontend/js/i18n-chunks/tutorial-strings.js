// Lazy-loaded i18n chunk for the first-run product tour (js/tutorial.js) —
// perf audit Phase 2. Registered into the live dictionary via i18n.js's
// registerDictionary() the moment a fresh sign-in resolves and
// maybeAutoStartTutorial()'s own condition needs checking (see app.js's
// loadTutorialModule(), called from the onSignedIn flow — this one isn't
// gated behind a tab click the way the others are, since the tutorial has
// no tab of its own; it's boot-adjacent but still not part of the
// always-loaded core bundle, since a RETURNING user who has already seen it
// never needs this weight at all). Generated from i18n.js's original single
// dictionary — content is byte-identical to what "tutorial.*" used to
// contain there, verified via a deep-equal check against the pre-split
// dictionary before this file was written; if you're hand-editing after
// this point, that guarantee no longer holds automatically, so keep en/ro
// in exact key-parity by hand (same discipline the original single-file
// dictionary always required — see i18n.js's own registerDictionary() for
// the automated check that now catches a drift here at load time instead
// of only by manual review).

export const en = {
  "tutorial": {
    "settingsSectionTitle": "App tutorial",
    "settingsHint": "Replay the guided walkthrough of the basics — logging food, water, and finding progress and settings.",
    "replayBtn": "Replay tutorial",
    "skipAriaLabel": "Skip tutorial",
    "backBtn": "Back",
    "startBtn": "Let's go!",
    "nextBtn": "Next",
    "doneBtn": "Got it!",
    "introTitle": "Hi, I'm Ollie! 👋",
    "introBody": "I'll walk you through everything — logging food, tracking water, your saved meals, progress, and settings. Let's dive in!",
    "introBodyReturning": "Good to see you again! There's a few newer bits worth a quick look — let's take a tour.",
    "ringTitle": "Your daily ring",
    "ringBody": "This shows calories remaining today, plus your protein, carbs, fats, and fiber underneath. See that small diagonal tick on the ring? That's your pace for the day — inside it and you're under pace, outside and you're over. You can turn it off anytime in Settings.",
    "foodTitle": "Log food here",
    "foodBody": "Tap the + button anytime you eat something — it opens a few quick ways to log it.",
    "optionsTitle": "Three ways to log",
    "optionsBody": "Scan with AI for instant macros, pick a saved favorite, or type the numbers in yourself.",
    "scanModesTitle": "Scan your way",
    "scanModesBody": "Snap a photo, type a quick description, or scan a barcode — you can even attach a scanned product to a description for extra precision.",
    "attachBarcodeTitle": "Attach a scanned product",
    "attachBarcodeBody": "Adding a photo or description of the rest of a meal? Attach a barcode-scanned product too for exact numbers on that part.",
    "waterTitle": "Track your water",
    "waterBody": "Give it a real tap — 250ml, logged instantly.",
    "waterBodyAlreadyLogged": "This is where you log water — 250ml per tap. Looks like you've already logged some today, so we'll skip adding more.",
    "waterDoneTitle": "Nice one! 🎉",
    "waterDoneBody": "That's exactly how it's done — 250ml logged for real.",
    "savedTitle": "Your saved meals",
    "savedBody": "Save any meal or product as a favorite, then re-log it here in one tap — Meals and Products get their own tabs.",
    "discoverTitle": "Discover",
    "discoverBody": "Browse recipes and workout plans, search the exercise library and food products — filter recipes/plans by Bulk, Cut, or Maintain to match your current goal.",
    "streakTitle": "Your streak",
    "streakBody": "See how many days in a row you've hit your targets, plus your water streak. Everything below is now grouped into tappable cards — tap any header to expand it for the full chart or list.",
    "workoutTitle": "Your workout diary",
    "workoutBody": "Track sets, reps, and weight for every exercise. Tap Open Diary for the full-screen workout diary — start a session, browse past workouts on the calendar, and see your estimated calories burned.",
    "milestonesTitle": "Milestones",
    "milestonesBody": "Badges you unlock as you build consistency — tap any one to see your progress toward it.",
    "aiCoachTitle": "Meet Ollie",
    "aiCoachBody": "Tap Ollie (or the status banner above your ring) for a proactive daily insight, quick answers, and a free-text chat whenever you need it. He's also a little mirror of your own habits: logging food feeds him, logging water keeps him hydrated, and his hearts heal or fade with how consistent your real days are. Tap the ? inside his sheet anytime for the full rundown.",
    "targetsTitle": "Your daily targets",
    "targetsBody": "Set your calorie and macro goals here, or let the calculator suggest them from your stats.",
    "goalTitle": "Cut, maintain, or bulk",
    "goalBody": "Pick your goal here — it tunes the calculator's suggestion and the tone of your dashboard's coaching messages.",
    "themeLangTitle": "Language & theme",
    "themeLangBody": "Switch between English and Română, and Light, Dark, or System — Dark is the default here.",
    "exportTitle": "Export your data",
    "exportBody": "Download a clean PDF report of your logs anytime — handy for your own records or a coach.",
    "outroTitle": "You're all set!",
    "outroBody": "That's the whole app. You can replay this tour anytime from Settings — now go log something!"
  }
};

export const ro = {
  "tutorial": {
    "settingsSectionTitle": "Tutorial aplicație",
    "settingsHint": "Reia parcursul ghidat al elementelor de bază — înregistrarea alimentelor, a apei și găsirea progresului și setărilor.",
    "replayBtn": "Reia tutorialul",
    "skipAriaLabel": "Sari peste tutorial",
    "backBtn": "Înapoi",
    "startBtn": "Să începem!",
    "nextBtn": "Următorul",
    "doneBtn": "Am înțeles!",
    "introTitle": "Salut, sunt Ollie! 👋",
    "introBody": "Îți arăt tot — înregistrarea alimentelor, urmărirea apei, mesele salvate, progresul și setările. Să începem!",
    "introBodyReturning": "Mă bucur să te revăd! Sunt câteva noutăți care merită o privire rapidă — hai să facem un tur.",
    "ringTitle": "Cercul tău zilnic",
    "ringBody": "Aici vezi caloriile rămase azi, plus proteinele, carbohidrații, grăsimile și fibrele dedesubt. Vezi acel mic reper diagonal de pe cerc? Este ritmul tău pentru ziua respectivă — înăuntru înseamnă că ești sub ritm, în afară înseamnă peste. Îl poți dezactiva oricând din Setări.",
    "foodTitle": "Înregistrează alimente aici",
    "foodBody": "Apasă butonul + oricând mănânci ceva — se deschid câteva moduri rapide de a-l înregistra.",
    "optionsTitle": "Trei moduri de a înregistra",
    "optionsBody": "Scanează cu AI pentru macronutrienți instant, alege un favorit salvat, sau introdu tu numerele.",
    "scanModesTitle": "Scanează cum vrei",
    "scanModesBody": "Fă o poză, scrie o descriere rapidă sau scanează un cod de bare — poți chiar atașa un produs scanat la o descriere pentru precizie în plus.",
    "attachBarcodeTitle": "Atașează un produs scanat",
    "attachBarcodeBody": "Adaugi o poză sau o descriere pentru restul mesei? Atașează și un produs scanat cu cod de bare pentru numere exacte la acea parte.",
    "waterTitle": "Urmărește-ți apa",
    "waterBody": "Încearcă chiar acum — 250ml, înregistrați instant.",
    "waterBodyAlreadyLogged": "Aici înregistrezi apa — 250ml pe atingere. Se pare că ai înregistrat deja azi, așa că nu mai adăugăm încă o dată.",
    "waterDoneTitle": "Perfect! 🎉",
    "waterDoneBody": "Exact așa se face — 250ml înregistrați cu adevărat.",
    "savedTitle": "Mesele tale salvate",
    "savedBody": "Salvează orice masă sau produs ca favorit, apoi reînregistrează-l aici dintr-o atingere — Mese și Produse au propriile taburi.",
    "discoverTitle": "Descoperă",
    "discoverBody": "Răsfoiește rețete și planuri de antrenament, caută în biblioteca de exerciții și produse alimentare — filtrează rețetele/planurile după Masă, Definire sau Menținere, în funcție de obiectivul tău actual.",
    "streakTitle": "Seria ta de zile",
    "streakBody": "Vezi câte zile la rând ți-ai atins obiectivele, plus seria ta pentru apă. Tot ce e dedesubt e acum grupat în carduri pe care le poți atinge — apasă orice titlu pentru a-l extinde și a vedea graficul sau lista completă.",
    "workoutTitle": "Jurnalul tău de antrenament",
    "workoutBody": "Urmărește seturi, repetări și greutăți pentru fiecare exercițiu. Apasă „Deschide jurnalul” pentru jurnalul de antrenament pe tot ecranul — începe o sesiune, răsfoiește antrenamentele anterioare în calendar și vezi caloriile estimate arse.",
    "milestonesTitle": "Realizări",
    "milestonesBody": "Insigne pe care le deblochezi pe măsură ce ești constant — apasă oricare pentru a-ți vedea progresul spre ea.",
    "aiCoachTitle": "Cunoaște-l pe Ollie",
    "aiCoachBody": "Apasă pe Ollie (sau pe bannerul de deasupra inelului tău) pentru o observație zilnică proactivă, răspunsuri rapide și un chat oricând ai nevoie. E și o mică oglindă a obiceiurilor tale: când înregistrezi mâncare îl hrănești, când înregistrezi apă rămâne hidratat, iar inimioarele lui se refac sau scad în funcție de cât de constante îți sunt zilele. Apasă pe „?” din ecranul lui oricând vrei toate detaliile.",
    "targetsTitle": "Obiectivele tale zilnice",
    "targetsBody": "Setează-ți obiectivele de calorii și macronutrienți aici, sau lasă calculatorul să ți le sugereze din datele tale.",
    "goalTitle": "Slăbire, menținere sau masă",
    "goalBody": "Alege-ți obiectivul aici — ajustează sugestia calculatorului și tonul mesajelor de coaching de pe ecranul tău principal.",
    "themeLangTitle": "Limbă și temă",
    "themeLangBody": "Comută între Engleză și Română, și Luminos, Întunecat sau Sistem — Întunecat este implicit aici.",
    "exportTitle": "Exportă-ți datele",
    "exportBody": "Descarcă oricând un raport PDF curat al înregistrărilor tale — util pentru evidența ta sau pentru un antrenor.",
    "outroTitle": "Ești gata!",
    "outroBody": "Asta e toată aplicația. Poți relua acest tur oricând din Setări — acum du-te și înregistrează ceva!"
  }
};
