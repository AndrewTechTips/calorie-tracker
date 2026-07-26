// Minimal, dependency-free i18n. Only English and Romanian are supported —
// deliberately not built as a generic n-language system since that's not
// what was asked for, and it keeps the translation dictionary reviewable in
// one sitting instead of scattering partial locales everywhere.
const STORAGE_KEY = "ironlog_lang";

const dict = {
  en: {
    auth: {
      brandSub: "Precision macro tracking for hypertrophy",
      tabLogin: "Log in",
      tabSignup: "Sign up",
      emailLabel: "Email",
      passwordLabel: "Password",
      submitLogin: "Log in",
      submitSignup: "Create account",
      errorGeneric: "Something went wrong, try again.",
      confirmEmail: "Account created — check your email to confirm, then log in.",
      captchaFailed: "Verification failed — please try again.",
      forgotPassword: "Forgot password?",
      submitReset: "Send reset link",
      resetLinkSent: "If that email has an account, a reset link is on its way — check your inbox.",
      setNewPasswordHint: "Choose a new password for your account.",
      newPasswordLabel: "New password",
      setNewPasswordBtn: "Set new password",
    },
    header: {
      settingsAriaLabel: "Settings",
      greetingMorning: "Good morning",
      greetingAfternoon: "Good afternoon",
      greetingEvening: "Good evening",
    },
    dashboard: {
      dayLabel: "Day {{n}}",
      kcalLeft: "kcal left",
      kcalOver: "kcal over",
      protein: "Protein",
      carbs: "Carbs",
      fats: "Fats",
      fiber: "Fiber",
      macroAbbrProtein: "P",
      macroAbbrCarbs: "C",
      macroAbbrFats: "F",
      water: "Water",
      waterCustom: "Custom",
      todaysLog: "Today's log",
      logEmpty: "No food logged yet today — tap the + button to start.",
      overByLabel: "{{amount}}g over target",
    },
    endDay: {
      button: "End day",
      title: "Today's summary",
      doneBtn: "Done — see you tomorrow",
      startedToast: "Day {{n}} started!",
      couldNotEnd: "Could not end the day — try again",
    },
    status: {
      plentyLeft: "{{remaining}} kcal remaining — you're right on pace.",
      plentyLeftNeedsProtein:
        "{{remaining}} kcal remaining — plenty of room today, so it's a great time to get your protein in early.",
      onTrack: "{{remaining}} kcal left today. Keep it balanced.",
      onTrackNeedsProtein:
        "{{remaining}} kcal left, and you're still {{protein}}g short on protein — good time for chicken, eggs, or a shake.",
      onTrackCarbsTopped:
        "{{remaining}} kcal left, but your carbs are already maxed for today — keep the rest lean with protein and veggies.",
      onTrackFatsTopped:
        "{{remaining}} kcal left, but fats are already topped off today — go leaner with what's left.",
      almostDone: "Almost there — only {{remaining}} kcal left today.",
      almostDoneNeedsProtein:
        "Only {{remaining}} kcal left, but you still need {{protein}}g protein — prioritize a lean protein source next.",
      exactlyOnTarget: "Right on target for today — nicely balanced.",
      overCalories:
        "You're {{over}} kcal over your goal today. That's okay — consider lighter, protein-forward choices for the rest of the day.",
      overCarbs:
        "You're {{over}} kcal over today, mostly from carbs — a lighter, protein-forward meal would help balance the rest of the day.",
      overFats:
        "You're {{over}} kcal over today, mostly from fats — go leaner for your next meal and you'll even it out.",
      proteinGoalHit: "Protein goal hit — {{remaining}} kcal left today. Nice work.",
    },
    saved: {
      heading: "Saved meals",
      newBtn: "+ New",
      empty: "No saved meals yet. Save any logged item as a favorite for instant re-logging.",
      logBtn: "Log",
      saveAction: "Save as favorite",
    },
    measurements: {
      sectionTitle: "Body measurements",
      newBtn: "+ Add",
      filterLabel: "Show",
      filterAll: "All measurements",
      empty: "No measurements logged yet. Add your first one (e.g. waist, chest, arm) to start tracking.",
      addTitle: "Add measurement",
      editTitle: "Edit measurement",
      nameLabel: "Measurement name",
      namePlaceholder: "e.g. Waist",
      valueLabel: "Value",
      unitLabel: "Unit",
      dateLabel: "Date",
      timeLabel: "Time",
      saveBtn: "Save measurement",
    },
    nav: {
      dashboard: "Dashboard",
      progress: "Progress",
      saved: "Saved",
      addFoodAriaLabel: "Add food",
    },
    addSheet: {
      title: "Add food",
      scanTitle: "Scan with AI",
      scanDesc: "Snap a photo, get instant macros",
      savedTitle: "Saved meal",
      savedDesc: "Log a favorite instantly",
      manualTitle: "Manual entry",
      manualDesc: "Type in the numbers yourself",
    },
    common: {
      cancel: "Cancel",
      edit: "Edit",
      delete: "Delete",
    },
    progress: {
      weightSectionTitle: "Body weight",
      weightInputLabel: "Weight (kg)",
      weightInputPlaceholder: "e.g. 78.5",
      logWeightBtn: "Log weight",
      weightEmpty: "No weigh-ins yet. Log your weight to start tracking your trend.",
      weightChartTitle: "Weight trend",
      trendSectionTitle: "This week",
      streakLabel: "day streak",
      streakNone: "No streak yet — stay within your calorie goal to start one",
      calorieTrendTitle: "Calories vs target",
      retentionNote: "Showing the last {{days}} days — older logs are cleared automatically to save storage.",
      avgLabel: "Avg",
      legendUnder: "Under target",
      legendOver: "Over target",
      legendTarget: "Target",
      vsLast: "vs last",
      noChange: "no change",
      dayHistoryTitle: "Daily history",
      today: "Today",
      noLogsShort: "No logs",
    },
    quota: {
      scanUsageLabel: "AI scans today",
      atCapacity: "AI scanning is at capacity for today. Try again tomorrow, or log manually.",
    },
    export: {
      sectionTitle: "Export your data",
      hint: "Download a CSV of your food, water, and weight logs.",
      rangeLabel: "Range",
      range2days: "Last 2 days",
      range3days: "Last 3 days",
      rangeAll: "Whole week",
      exportBtn: "Export data",
      exportSuccess: "Export downloaded",
      exportFailed: "Could not export your data",
    },
    reminders: {
      sectionTitle: "Reminders",
      enableLabel: "Daily reminder to log",
      timeLabel: "Reminder time",
      foregroundNote: "Fires while the app is open or installed — not a true background push notification.",
      permissionDenied: "Notifications are blocked in your browser settings — enable them to use reminders.",
      enabledToast: "Reminders enabled",
      disabledToast: "Reminders disabled",
      notificationBody: "Don't forget to log today's meals and water!",
      smartNudgeLabel: "Smart nudges (water & meals, based on your activity)",
      smartNudgeEnabledToast: "Smart nudges enabled",
      smartNudgeDisabledToast: "Smart nudges disabled",
      waterNudgeBody: "You haven't logged water in a while — stay hydrated.",
      foodNudgeBody: "You haven't logged any food today.",
    },
    install: {
      sectionTitle: "Install app",
      hint: "Get Iron Log on your home screen — launches instantly, feels like a native app.",
      button: "Install app",
      iosInstructions: "Tap the Share icon, then \"Add to Home Screen\".",
      installedToast: "Iron Log installed",
    },
    scan: {
      title: "Scan food",
      tabPhoto: "Photo",
      tabBarcode: "Barcode",
      dropzonePointer: "Click to upload, or drag & drop a photo",
      dropzoneTouch: "Tap to choose a photo",
      takePhotoBtn: "Take a photo",
      contextLabel: "Context",
      contextHint: "(optional — portion, sauce, etc.)",
      contextPlaceholder: 'e.g. "grilled, no oil, ~1 cup rice"',
      analyzeBtn: "Analyze photo",
      loadingText: "Reading your plate…",
      errorGeneric: "Could not analyze that photo. Try again.",
      saveFavorite: "Also save as a favorite meal",
      confirmLog: "Confirm & log",
      barcodeHint: "Point your camera at a barcode",
      barcodeUnsupported: "Barcode scanning isn't supported in this browser. Try AI photo scan or manual entry instead.",
      barcodeCameraError: "Couldn't access the camera. Check your permissions and try again.",
      barcodeLooking: "Looking up product…",
    },
    field: {
      foodName: "Food name",
      weight: "Weight (g)",
      calories: "Calories",
      protein: "Protein (g)",
      carbs: "Carbs (g)",
      fats: "Fats (g)",
      fiber: "Fiber (g)",
    },
    manual: {
      titleNew: "Manual entry",
      titleEdit: "Edit food",
      submitNew: "Log food",
      submitEdit: "Save changes",
      submitUpdating: "Updating…",
    },
    water: {
      title: "Water",
      customPlaceholder: "Custom amount (ml)",
      customAriaLabel: "Custom water amount in milliliters",
      addBtn: "Add",
      todaysEntries: "Today's entries",
      empty: "No water logged yet today.",
      close: "Close",
    },
    settings: {
      title: "Daily targets",
      displayName: "Your name",
      displayNamePlaceholder: "e.g. Andrew",
      calories: "Calories (kcal)",
      protein: "Protein (g)",
      carbs: "Carbs (g)",
      fats: "Fats (g)",
      fiber: "Fiber (g)",
      water: "Water (ml)",
      save: "Save targets",
      saving: "Saving…",
      logout: "Log out",
      close: "Close",
      language: "Language",
    },
    toast: {
      loggedSuccess: "Logged!",
      removed: "Removed",
      updated: "Updated!",
      targetsUpdated: "Targets updated",
      loadingData: "Loading your data…",
      wakingServer: "Waking up the server — first load can take up to a minute.",
      someDataFailed: "Some data could not be loaded",
      couldNotSaveEntryRemoved: "Could not save that entry — removed",
      loggedButFavoriteFailed: "Logged, but couldn't save as a favorite",
      couldNotLogMealRemoved: "Could not log that meal — removed",
      couldNotUpdateEntry: "Could not update that entry",
      couldNotUpdateEntryReverted: "Could not update that entry — reverted",
      couldNotDeleteEntryRestored: "Could not delete that entry — restored",
      couldNotDeleteMealRestored: "Could not delete that meal — restored",
      couldNotLoadTargets: "Could not load your targets — try again",
      couldNotUpdateTargets: "Could not update targets",
      enterAmountGreaterThanZero: "Enter an amount greater than 0",
      maxAmountPerEntry: "Max {{max}} ml per entry",
      waterLogged: "+{{amount}} ml logged",
      waterLimitReached: "Daily water limit reached ({{max}} L)",
      couldNotLogWaterReverted: "Could not log water — reverted",
      weightLogged: "Weight logged!",
      couldNotLogWeight: "Could not log weight",
      savedAsFavorite: "Saved as favorite",
      couldNotSaveFavorite: "Could not save as favorite",
      measurementLogged: "Measurement logged!",
      couldNotLogMeasurement: "Could not save that measurement",
    },
    api: {
      notSignedIn: "Not signed in",
      sessionExpired: "Your session expired — please log in again.",
      rateLimited: "You're doing that a bit too fast — please wait a moment and try again.",
      timeout: "The server is taking too long to respond. Please try again.",
      unreachable: "Could not reach the server. Check your connection and try again.",
    },
  },
  ro: {
    auth: {
      brandSub: "Urmărire precisă a macronutrienților pentru hipertrofie",
      tabLogin: "Autentificare",
      tabSignup: "Înregistrare",
      emailLabel: "Email",
      passwordLabel: "Parolă",
      submitLogin: "Autentificare",
      submitSignup: "Creează cont",
      errorGeneric: "Ceva nu a funcționat, încearcă din nou.",
      confirmEmail: "Cont creat — verifică-ți emailul pentru confirmare, apoi autentifică-te.",
      captchaFailed: "Verificarea a eșuat — încearcă din nou.",
      forgotPassword: "Ai uitat parola?",
      submitReset: "Trimite linkul de resetare",
      resetLinkSent: "Dacă acel email are un cont, un link de resetare e pe drum — verifică-ți inboxul.",
      setNewPasswordHint: "Alege o parolă nouă pentru contul tău.",
      newPasswordLabel: "Parolă nouă",
      setNewPasswordBtn: "Setează parola nouă",
    },
    header: {
      settingsAriaLabel: "Setări",
      greetingMorning: "Bună dimineața",
      greetingAfternoon: "Bună ziua",
      greetingEvening: "Bună seara",
    },
    dashboard: {
      dayLabel: "Ziua {{n}}",
      kcalLeft: "kcal rămase",
      kcalOver: "kcal peste",
      protein: "Proteine",
      carbs: "Carbohidrați",
      fats: "Grăsimi",
      fiber: "Fibre",
      macroAbbrProtein: "P",
      macroAbbrCarbs: "C",
      macroAbbrFats: "G",
      water: "Apă",
      waterCustom: "Personalizat",
      todaysLog: "Jurnalul de azi",
      logEmpty: "Niciun aliment înregistrat azi — apasă butonul + pentru a începe.",
      overByLabel: "{{amount}}g peste obiectiv",
    },
    endDay: {
      button: "Încheie ziua",
      title: "Rezumatul zilei",
      doneBtn: "Gata — pe mâine",
      startedToast: "A început ziua {{n}}!",
      couldNotEnd: "Nu am putut încheia ziua — încearcă din nou",
    },
    status: {
      plentyLeft: "{{remaining}} kcal rămase — ești exact pe planul tău.",
      plentyLeftNeedsProtein:
        "{{remaining}} kcal rămase — ai destul spațiu azi, deci e un moment bun să iei proteinele din timp.",
      onTrack: "{{remaining}} kcal rămase azi. Menține echilibrul.",
      onTrackNeedsProtein:
        "{{remaining}} kcal rămase, dar mai ai nevoie de {{protein}}g proteine — un moment bun pentru pui, ouă sau un shake.",
      onTrackCarbsTopped:
        "{{remaining}} kcal rămase, dar carbohidrații sunt deja la maxim azi — menține restul zilei simplu, cu proteine și legume.",
      onTrackFatsTopped:
        "{{remaining}} kcal rămase, dar grăsimile sunt deja la maxim azi — alege ceva mai slab pentru ce urmează.",
      almostDone: "Aproape ai terminat — doar {{remaining}} kcal rămase azi.",
      almostDoneNeedsProtein:
        "Doar {{remaining}} kcal rămase, dar mai ai nevoie de {{protein}}g proteine — alege o sursă slabă de proteine la următoarea masă.",
      exactlyOnTarget: "Exact pe obiectivul de azi — bine echilibrat.",
      overCalories:
        "Ești cu {{over}} kcal peste obiectivul de azi. Nu-i nicio problemă — alege mese mai ușoare, bogate în proteine, pentru restul zilei.",
      overCarbs:
        "Ești cu {{over}} kcal peste azi, mai ales din carbohidrați — o masă mai ușoară, bogată în proteine, ar echilibra restul zilei.",
      overFats:
        "Ești cu {{over}} kcal peste azi, mai ales din grăsimi — alege ceva mai slab la următoarea masă și se echilibrează.",
      proteinGoalHit: "Obiectiv de proteine atins — {{remaining}} kcal rămase azi. Bravo!",
    },
    saved: {
      heading: "Mese salvate",
      newBtn: "+ Nou",
      empty: "Nicio masă salvată încă. Salvează orice aliment înregistrat ca favorit pentru reînregistrare instantanee.",
      logBtn: "Înregistrează",
      saveAction: "Salvează ca favorit",
    },
    measurements: {
      sectionTitle: "Măsurători corporale",
      newBtn: "+ Adaugă",
      filterLabel: "Arată",
      filterAll: "Toate măsurătorile",
      empty: "Nicio măsurătoare înregistrată încă. Adaugă prima măsurătoare (ex. talie, piept, braț) pentru a începe urmărirea.",
      addTitle: "Adaugă măsurătoare",
      editTitle: "Editează măsurătoarea",
      nameLabel: "Numele măsurătorii",
      namePlaceholder: "ex. Talie",
      valueLabel: "Valoare",
      unitLabel: "Unitate",
      dateLabel: "Data",
      timeLabel: "Ora",
      saveBtn: "Salvează măsurătoarea",
    },
    nav: {
      dashboard: "Panou",
      progress: "Progres",
      saved: "Salvate",
      addFoodAriaLabel: "Adaugă aliment",
    },
    addSheet: {
      title: "Adaugă aliment",
      scanTitle: "Scanează cu AI",
      scanDesc: "Fă o poză, obții macro-uri instant",
      savedTitle: "Masă salvată",
      savedDesc: "Înregistrează un favorit instant",
      manualTitle: "Introducere manuală",
      manualDesc: "Introdu tu valorile",
    },
    common: {
      cancel: "Anulează",
      edit: "Editează",
      delete: "Șterge",
    },
    progress: {
      weightSectionTitle: "Greutate corporală",
      weightInputLabel: "Greutate (kg)",
      weightInputPlaceholder: "ex. 78.5",
      logWeightBtn: "Înregistrează greutatea",
      weightEmpty: "Nicio greutate înregistrată încă. Înregistrează-ți greutatea pentru a începe să urmărești tendința.",
      weightChartTitle: "Tendință greutate",
      trendSectionTitle: "Săptămâna aceasta",
      streakLabel: "zile la rând",
      streakNone: "Niciun streak încă — respectă obiectivul caloric pentru a începe unul",
      calorieTrendTitle: "Calorii vs obiectiv",
      retentionNote: "Se afișează ultimele {{days}} zile — înregistrările mai vechi sunt șterse automat pentru economisirea spațiului.",
      avgLabel: "Medie",
      legendUnder: "Sub obiectiv",
      legendOver: "Peste obiectiv",
      legendTarget: "Obiectiv",
      vsLast: "față de ultima",
      noChange: "fără schimbare",
      dayHistoryTitle: "Istoric zilnic",
      today: "Azi",
      noLogsShort: "Fără înregistrări",
    },
    quota: {
      scanUsageLabel: "Scanări AI azi",
      atCapacity: "Scanarea AI a atins capacitatea pentru azi. Încearcă mâine, sau înregistrează manual.",
    },
    export: {
      sectionTitle: "Exportă-ți datele",
      hint: "Descarcă un fișier CSV cu mesele, apa și greutatea înregistrate.",
      rangeLabel: "Interval",
      range2days: "Ultimele 2 zile",
      range3days: "Ultimele 3 zile",
      rangeAll: "Toată săptămâna",
      exportBtn: "Exportă datele",
      exportSuccess: "Export descărcat",
      exportFailed: "Nu am putut exporta datele",
    },
    reminders: {
      sectionTitle: "Mementouri",
      enableLabel: "Memento zilnic pentru înregistrare",
      timeLabel: "Ora mementoului",
      foregroundNote: "Se declanșează doar cât timp aplicația este deschisă sau instalată — nu este o notificare push reală în fundal.",
      permissionDenied: "Notificările sunt blocate în setările browserului — activează-le pentru a folosi mementourile.",
      enabledToast: "Mementouri activate",
      disabledToast: "Mementouri dezactivate",
      notificationBody: "Nu uita să înregistrezi mesele și apa de azi!",
      smartNudgeLabel: "Mementouri inteligente (apă & mese, în funcție de activitate)",
      smartNudgeEnabledToast: "Mementouri inteligente activate",
      smartNudgeDisabledToast: "Mementouri inteligente dezactivate",
      waterNudgeBody: "N-ai mai înregistrat apă de ceva vreme — hidratează-te.",
      foodNudgeBody: "N-ai înregistrat nicio masă azi.",
    },
    install: {
      sectionTitle: "Instalează aplicația",
      hint: "Adaugă Iron Log pe ecranul principal — pornește instant și se simte ca o aplicație nativă.",
      button: "Instalează aplicația",
      iosInstructions: "Apasă pe iconița de distribuire, apoi „Adaugă pe ecranul principal”.",
      installedToast: "Iron Log a fost instalat",
    },
    scan: {
      title: "Scanează aliment",
      tabPhoto: "Foto",
      tabBarcode: "Cod de bare",
      dropzonePointer: "Apasă pentru a încărca, sau trage o poză aici",
      dropzoneTouch: "Apasă pentru a alege o poză",
      takePhotoBtn: "Fă o poză",
      contextLabel: "Context",
      contextHint: "(opțional — porție, sos, etc.)",
      contextPlaceholder: 'ex. "la grătar, fără ulei, ~1 cană orez"',
      analyzeBtn: "Analizează poza",
      loadingText: "Analizez farfuria…",
      errorGeneric: "Nu am putut analiza poza. Încearcă din nou.",
      saveFavorite: "Salvează și ca masă favorită",
      confirmLog: "Confirmă și înregistrează",
      barcodeHint: "Îndreaptă camera spre un cod de bare",
      barcodeUnsupported: "Scanarea codurilor de bare nu este suportată în acest browser. Încearcă scanarea foto AI sau introducerea manuală.",
      barcodeCameraError: "Nu am putut accesa camera. Verifică permisiunile și încearcă din nou.",
      barcodeLooking: "Se caută produsul…",
    },
    field: {
      foodName: "Nume aliment",
      weight: "Greutate (g)",
      calories: "Calorii",
      protein: "Proteine (g)",
      carbs: "Carbohidrați (g)",
      fats: "Grăsimi (g)",
      fiber: "Fibre (g)",
    },
    manual: {
      titleNew: "Introducere manuală",
      titleEdit: "Editează aliment",
      submitNew: "Înregistrează",
      submitEdit: "Salvează modificările",
      submitUpdating: "Se actualizează…",
    },
    water: {
      title: "Apă",
      customPlaceholder: "Cantitate personalizată (ml)",
      customAriaLabel: "Cantitate personalizată de apă în mililitri",
      addBtn: "Adaugă",
      todaysEntries: "Înregistrări de azi",
      empty: "Nicio cantitate de apă înregistrată azi.",
      close: "Închide",
    },
    settings: {
      title: "Obiective zilnice",
      displayName: "Numele tău",
      displayNamePlaceholder: "ex. Andrei",
      calories: "Calorii (kcal)",
      protein: "Proteine (g)",
      carbs: "Carbohidrați (g)",
      fats: "Grăsimi (g)",
      fiber: "Fibre (g)",
      water: "Apă (ml)",
      save: "Salvează obiectivele",
      saving: "Se salvează…",
      logout: "Deconectare",
      close: "Închide",
      language: "Limbă",
    },
    toast: {
      loggedSuccess: "Înregistrat!",
      removed: "Șters",
      updated: "Actualizat!",
      targetsUpdated: "Obiective actualizate",
      loadingData: "Se încarcă datele tale…",
      wakingServer: "Serverul pornește — prima încărcare poate dura până la un minut.",
      someDataFailed: "Unele date nu au putut fi încărcate",
      couldNotSaveEntryRemoved: "Nu am putut salva înregistrarea — a fost ștearsă",
      loggedButFavoriteFailed: "Înregistrat, dar nu am putut salva ca favorit",
      couldNotLogMealRemoved: "Nu am putut înregistra masa — a fost ștearsă",
      couldNotUpdateEntry: "Nu am putut actualiza înregistrarea",
      couldNotUpdateEntryReverted: "Nu am putut actualiza înregistrarea — revenire la starea anterioară",
      couldNotDeleteEntryRestored: "Nu am putut șterge înregistrarea — a fost restaurată",
      couldNotDeleteMealRestored: "Nu am putut șterge masa — a fost restaurată",
      couldNotLoadTargets: "Nu am putut încărca obiectivele — încearcă din nou",
      couldNotUpdateTargets: "Nu am putut actualiza obiectivele",
      enterAmountGreaterThanZero: "Introdu o cantitate mai mare de 0",
      maxAmountPerEntry: "Max {{max}} ml per înregistrare",
      waterLogged: "+{{amount}} ml înregistrat",
      waterLimitReached: "Limita zilnică de apă a fost atinsă ({{max}} L)",
      couldNotLogWaterReverted: "Nu am putut înregistra apa — revenire la starea anterioară",
      weightLogged: "Greutate înregistrată!",
      couldNotLogWeight: "Nu am putut înregistra greutatea",
      savedAsFavorite: "Salvat ca favorit",
      couldNotSaveFavorite: "Nu am putut salva ca favorit",
      measurementLogged: "Măsurătoare înregistrată!",
      couldNotLogMeasurement: "Nu am putut salva măsurătoarea",
    },
    api: {
      notSignedIn: "Neautentificat",
      sessionExpired: "Sesiunea a expirat — te rugăm să te autentifici din nou.",
      rateLimited: "Faci asta puțin cam repede — te rugăm să aștepți un moment și să încerci din nou.",
      timeout: "Serverul răspunde prea greu. Te rugăm să încerci din nou.",
      unreachable: "Nu am putut contacta serverul. Verifică-ți conexiunea și încearcă din nou.",
    },
  },
};

function detectDefaultLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "ro") return stored;
  return (navigator.language || "").toLowerCase().startsWith("ro") ? "ro" : "en";
}

let currentLang = detectDefaultLang();
const listeners = new Set();

function lookup(lang, key) {
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), dict[lang]);
}

export function t(key, vars) {
  let value = lookup(currentLang, key);
  if (value === undefined) value = lookup("en", key); // safety net, should never be needed
  if (value === undefined) return key;
  if (vars) {
    for (const [name, val] of Object.entries(vars)) {
      value = value.replace(new RegExp(`{{${name}}}`, "g"), String(val));
    }
  }
  return value;
}

export function getLanguage() {
  return currentLang;
}

export function getLocale() {
  return currentLang === "ro" ? "ro-RO" : "en-US";
}

export function setLanguage(lang) {
  if (lang !== "en" && lang !== "ro") return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  applyStaticTranslations();
  listeners.forEach((fn) => fn(lang));
}

export function onLanguageChange(fn) {
  listeners.add(fn);
}

// Applies translations to every element in the DOM carrying a data-i18n*
// attribute. Static markup (labels, headings, placeholders, aria-labels) is
// annotated declaratively in index.html; anything computed at runtime
// (toasts, dynamic sheet titles, log item text) is translated at its own
// call site via t() instead, since it isn't present in the DOM up front.
export function applyStaticTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
}

export function initI18n() {
  document.documentElement.lang = currentLang;
  applyStaticTranslations();
}
