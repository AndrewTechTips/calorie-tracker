// Exercise/muscle-group display translation for the Workout Diary — RO only.
//
// backend/routers/discover.py is explicit that exercise names/categories/
// muscles are never localized server-side (curated + wger.de content alike
// is English-only, and wger has no Romanian translation for any of it — see
// that router's own comment). That's a deliberate backend scope decision,
// not something this file works around: the API keeps returning English,
// and every `exercise_name`/`category` this app sends back to the backend
// (set logging, session payloads, muscle/equipment filters) stays exactly
// the string the API gave us. This module only reformats what's already on
// screen, in the DOM, for a Romanian-language reader — a local dictionary,
// not a translation service (no external API call, matching this app's
// no-new-external-dependency posture elsewhere).
//
// Coverage is deliberately partial, not exhaustive: it's tuned for the
// curated POPULAR_EXERCISES set (backend/data/discover_data.py, the default
// "no query yet" result and by far the most-seen names) via exact full-name
// matches, then falls back to word/phrase substitution for whatever a live
// wger.de search turns up — anatomical Latin terms wger emits for `muscles`
// (e.g. "Pectoralis major") are covered too, but an exercise name built from
// words outside this dictionary just keeps whatever pieces of it in English;
// that's a strictly better result than the untranslated status quo, not a
// bug to chase to 100%.

// Exact matches for the curated POPULAR_EXERCISES list — idiomatic phrasing
// rather than a word-by-word substitution, since these are a small, fixed,
// well-known set of names worth getting right individually.
const EXACT_NAME_MAP = {
  "barbell back squat": "Genuflexiune cu bară (spate)",
  "deadlift": "Îndreptări",
  "romanian deadlift": "Îndreptări românești",
  "bench press": "Împins culcat (bench press)",
  "incline bench press": "Împins culcat înclinat",
  "overhead press": "Împins deasupra capului",
  "dumbbell shoulder press": "Împins din umeri cu gantere",
  "barbell row": "Ramat cu bara",
  "seated cable row": "Ramat la cablu, șezând",
  "pull-up": "Tracțiuni",
  "chin-up": "Tracțiuni (priză supinată)",
  "push-up": "Flotări",
  "plank": "Podul (plank)",
  "walking lunge": "Fandare mers",
  "leg press": "Presă de picioare",
  "leg curl": "Flexia genunchiului (leg curl)",
  "leg extension": "Extensia genunchiului (leg extension)",
  "standing calf raise": "Ridicare pe vârfuri, în picioare",
  "lat pulldown": "Tracțiune la helcometru (lat pulldown)",
  "dumbbell bicep curl": "Flexii biceps cu gantere",
  "triceps pushdown": "Extensii triceps la cablu",
  "lateral raise": "Ridicări laterale",
  "face pull": "Face pull",
  "hip thrust": "Împins din șold (hip thrust)",
  "dip": "Dips",
};

// Word/phrase substitution for anything not in EXACT_NAME_MAP — longest
// phrase first so e.g. "bench press" (if it slips through unmatched above)
// wins over the standalone "press" entry.
const PHRASE_MAP = [
  ["romanian deadlift", "îndreptări românești"],
  ["bulgarian split squat", "genuflexiune bulgărească"],
  ["bench press", "împins culcat"],
  ["shoulder press", "împins din umeri"],
  ["leg press", "presă de picioare"],
  ["leg curl", "flexii picioare"],
  ["leg extension", "extensii picioare"],
  ["calf raise", "ridicări pe vârfuri"],
  ["lat pulldown", "tracțiune helcometru"],
  ["bicep curl", "flexii biceps"],
  ["tricep pushdown", "extensii triceps"],
  ["triceps pushdown", "extensii triceps"],
  ["lateral raise", "ridicare laterală"],
  ["face pull", "tracțiune la față"],
  ["hip thrust", "împins din șold"],
  ["split squat", "genuflexiune cu picior ridicat"],
  ["front squat", "genuflexiune frontală"],
  ["back squat", "genuflexiune spate"],
  ["goblet squat", "genuflexiune goblet"],
  ["close-grip", "priză îngustă"],
  ["wide-grip", "priză largă"],
  ["single-arm", "cu un braț"],
  ["single-leg", "cu un picior"],
  ["pull-up", "tracțiuni"],
  ["chin-up", "tracțiuni supinat"],
  ["push-up", "flotări"],
  ["sit-up", "abdomene"],
];

const WORD_MAP = {
  squat: "genuflexiune",
  deadlift: "îndreptări",
  press: "împins",
  row: "ramat",
  curl: "flexie",
  extension: "extensie",
  raise: "ridicare",
  pulldown: "tracțiune",
  pushdown: "extensie",
  fly: "fluturări",
  flye: "fluturări",
  crunch: "abdomene",
  plank: "podul",
  lunge: "fandare",
  dip: "dips",
  thrust: "împins",
  pull: "tracțiune",
  push: "împins",
  barbell: "bară",
  dumbbell: "gantere",
  cable: "cablu",
  machine: "aparat",
  bodyweight: "greutate corporală",
  kettlebell: "kettlebell",
  bar: "bară",
  bench: "bancă",
  incline: "înclinat",
  decline: "declinat",
  flat: "plat",
  standing: "în picioare",
  seated: "șezând",
  lying: "culcat",
  reverse: "invers",
  underhand: "priză supinată",
  overhand: "priză pronată",
  front: "frontal",
  back: "spate",
  walking: "mers",
  narrow: "îngust",
  wide: "larg",
  weighted: "cu greutate",
  assisted: "asistat",
};

// wger's `category` field — a small, fixed taxonomy, so a plain lookup
// table covers it completely (unlike free-text exercise names).
const CATEGORY_MAP = {
  chest: "Piept",
  back: "Spate",
  legs: "Picioare",
  shoulders: "Umeri",
  arms: "Brațe",
  abs: "Abdomen",
  core: "Trunchi",
  calves: "Gambe",
  glutes: "Fesieri",
  cardio: "Cardio",
  "full body": "Corp întreg",
  other: "Altele",
};

// wger's `muscles`/POPULAR_EXERCISES' plain-English muscle names, mixed —
// covers both the Latin anatomical terms live wger search returns and the
// everyday English words the curated list uses for the same body parts.
const MUSCLE_MAP = {
  chest: "Piept",
  "pectoralis major": "Piept (pectoral mare)",
  back: "Spate",
  "upper back": "Spate sus",
  "lower back": "Spate jos",
  "latissimus dorsi": "Marele dorsal",
  lats: "Dorsali",
  trapezius: "Trapez",
  "erector spinae": "Erectori spinali",
  shoulders: "Umeri",
  "rear delts": "Deltoid posterior",
  "deltoideus anterior": "Deltoid anterior",
  "deltoideus lateralis": "Deltoid lateral",
  "deltoideus posterior": "Deltoid posterior",
  biceps: "Biceps",
  "biceps brachii": "Biceps",
  triceps: "Triceps",
  "triceps brachii": "Triceps",
  brachialis: "Brahial",
  forearms: "Antebrațe",
  abs: "Abdomen",
  core: "Trunchi",
  "rectus abdominis": "Drepți abdominali",
  "obliquus externus abdominis": "Oblici externi",
  obliques: "Oblici",
  glutes: "Fesieri",
  "gluteus maximus": "Fesier mare",
  quadriceps: "Cvadriceps",
  "quadriceps femoris": "Cvadriceps",
  hamstrings: "Ischiogambieri",
  calves: "Gambe",
  gastrocnemius: "Gambier (gastrocnemian)",
  soleus: "Solear",
  "serratus anterior": "Dințat anterior",
  "hip flexors": "Flexori de șold",
  adductors: "Adductori",
  abductors: "Abductori",
};

function lowerTrim(s) {
  return (s || "").trim().toLowerCase();
}

// Case-preserving-ish word substitution: replaces whole words/phrases found
// in WORD_MAP/PHRASE_MAP, leaves anything unmapped untouched. Not real NLP —
// deliberately simple, matching "lightweight local dictionary" scope.
function substituteWords(text) {
  let result = text;
  for (const [en, ro] of PHRASE_MAP) {
    result = result.replace(new RegExp(`\\b${en}\\b`, "gi"), ro);
  }
  result = result.replace(/[A-Za-zĂÂÎȘȚăâîșț]+/g, (word) => {
    const mapped = WORD_MAP[word.toLowerCase()];
    if (!mapped) return word;
    // Preserve a leading capital if the original word had one (start of the
    // name, or a proper-noun-styled entry from wger).
    return word[0] === word[0].toUpperCase() ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
  });
  return result;
}

/** Translates an exercise name for display. Returns the original English
 * name unchanged outside Romanian — callers should still send the untouched
 * original to the API (this never mutates the value that gets logged). */
export function translateExerciseName(name, lang) {
  if (lang !== "ro" || !name) return name;
  const exact = EXACT_NAME_MAP[lowerTrim(name)];
  if (exact) return exact;
  return substituteWords(name);
}

export function translateCategory(category, lang) {
  if (lang !== "ro" || !category) return category;
  return CATEGORY_MAP[lowerTrim(category)] || category;
}

export function translateMuscle(muscle, lang) {
  if (lang !== "ro" || !muscle) return muscle;
  return MUSCLE_MAP[lowerTrim(muscle)] || muscle;
}
