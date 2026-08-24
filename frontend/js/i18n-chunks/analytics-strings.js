// Lazy-loaded i18n chunk for the Adaptive Goal analytics card
// (js/analytics.js, rendered inside the Progress tab) — perf audit Phase 2.
// Registered into the live dictionary via i18n.js's registerDictionary()
// the first time the Progress tab is opened (analytics.js loads alongside
// progress.js — see app.js's loadProgressModule()), not present in the
// always-loaded core bundle. Generated from i18n.js's original single
// dictionary — content is byte-identical to what "analytics.*" used to
// contain there, verified via a deep-equal check against the pre-split
// dictionary before this file was written; if you're hand-editing after
// this point, that guarantee no longer holds automatically, so keep en/ro
// in exact key-parity by hand (same discipline the original single-file
// dictionary always required — see i18n.js's own registerDictionary() for
// the automated check that now catches a drift here at load time instead
// of only by manual review).

export const en = {
  "analytics": {
    "groupLabel": "Predictive analytics",
    "forecastTitle": "Weight forecast",
    "forecastSubtitle": "Where your trend is headed.",
    "forecastInfoAria": "About weight forecast",
    "forecastEmpty": "Log your weight at least once to unlock a forecast.",
    "currentWeight": "Current",
    "bmrLabel": "Est. BMR",
    "tdeeLabel": "Est. maintenance",
    "trainingBurnLabel": "Training burn (7-day avg)",
    "trainingBurnUsed": "Included in your maintenance estimate above.",
    "trainingBurnNotUsed": "Not counted separately — your trend-based estimate already reflects it.",
    "projectionDays": "{{days}} days",
    "chartToday": "Today",
    "chartDayLabel": "{{days}}d",
    "methodRegression": "Based on your actual logged trend over the last {{days}} days.",
    "methodFormula": "Based on a standard formula — log more weigh-ins over time for a personalized estimate.",
    "anomalyNote": "{{count}} day(s) excluded from this estimate — logged calories looked too low to be a complete day's log.",
    "adaptiveTitle": "Adaptive goals",
    "adaptiveSubtitle": "Are your targets still on track?",
    "adaptiveInfoAria": "About adaptive goals",
    "adaptiveEmpty": "Log your weight to get a weekly evaluation of your targets.",
    "reasonOnTrack": "You're on track — your current targets match your goal.",
    "reasonStalledNoProgress": "Progress has stalled — your weight trend is barely moving toward your goal.",
    "reasonStalledWrongDirection": "Your weight is moving the wrong way for your goal.",
    "reasonDrifting": "Your weight is drifting more than expected for a maintain goal.",
    "reasonInsufficientData": "Not enough weigh-in history yet for a confident read — here's a starting estimate.",
    "suggestedCalories": "Suggested calories",
    "suggestedProtein": "Protein",
    "suggestedCarbs": "Carbs",
    "suggestedFats": "Fats",
    "lockMacroLabel": "Lock a macro (keeps it fixed, rebalances the rest)",
    "lockNone": "None",
    "applyBtn": "Apply suggested targets",
    "applySuccess": "Targets updated.",
    "applyError": "Couldn't apply the suggested targets."
  }
};

export const ro = {
  "analytics": {
    "groupLabel": "Analiză predictivă",
    "forecastTitle": "Prognoză greutate",
    "forecastSubtitle": "Încotro se îndreaptă tendința ta.",
    "forecastInfoAria": "Despre prognoza greutății",
    "forecastEmpty": "Înregistrează-ți greutatea cel puțin o dată pentru a debloca o prognoză.",
    "currentWeight": "Actuală",
    "bmrLabel": "BMR estimat",
    "tdeeLabel": "Menținere estimată",
    "trainingBurnLabel": "Calorii arse la antrenament (medie 7 zile)",
    "trainingBurnUsed": "Inclusă în estimarea de menținere de mai sus.",
    "trainingBurnNotUsed": "Nu e adăugată separat — estimarea bazată pe tendință o reflectă deja.",
    "projectionDays": "{{days}} zile",
    "chartToday": "Azi",
    "chartDayLabel": "{{days}}z",
    "methodRegression": "Pe baza tendinței tale reale înregistrate din ultimele {{days}} zile.",
    "methodFormula": "Pe baza unei formule standard — înregistrează mai multe cântăriri în timp pentru o estimare personalizată.",
    "anomalyNote": "{{count}} zi(le) excluse din această estimare — caloriile înregistrate au părut prea mici pentru o zi completă de jurnal.",
    "adaptiveTitle": "Obiective adaptive",
    "adaptiveSubtitle": "Obiectivele tale mai sunt potrivite?",
    "adaptiveInfoAria": "Despre obiectivele adaptive",
    "adaptiveEmpty": "Înregistrează-ți greutatea pentru a primi o evaluare săptămânală a obiectivelor tale.",
    "reasonOnTrack": "Ești pe drumul cel bun — obiectivele tale actuale corespund scopului tău.",
    "reasonStalledNoProgress": "Progresul a stagnat — tendința greutății tale abia se mișcă spre obiectiv.",
    "reasonStalledWrongDirection": "Greutatea ta se mișcă în direcția greșită pentru obiectivul tău.",
    "reasonDrifting": "Greutatea ta variază mai mult decât e de așteptat pentru un obiectiv de menținere.",
    "reasonInsufficientData": "Încă nu sunt suficiente cântăriri pentru o citire sigură — iată o estimare de pornire.",
    "suggestedCalories": "Calorii sugerate",
    "suggestedProtein": "Proteine",
    "suggestedCarbs": "Carbohidrați",
    "suggestedFats": "Grăsimi",
    "lockMacroLabel": "Blochează un macronutrient (rămâne fix, restul se rebalansează)",
    "lockNone": "Niciunul",
    "applyBtn": "Aplică obiectivele sugerate",
    "applySuccess": "Obiective actualizate.",
    "applyError": "Nu am putut aplica obiectivele sugerate."
  }
};
