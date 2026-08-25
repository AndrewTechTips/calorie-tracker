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

// Small connector words that are fine to leave in English inside an
// otherwise-translated name (they read as neutral, not as a language mix) —
// used only to decide whether substituteWords() produced a clean result,
// never substituted themselves.
const STOPWORDS_OK = new Set(["a", "an", "the", "of", "with", "to", "in", "on", "for", "and", "at", "from", "into", "or"]);

// Case-preserving-ish word substitution: replaces whole words/phrases found
// in WORD_MAP/PHRASE_MAP, leaves anything unmapped untouched. Not real NLP —
// deliberately simple, matching "lightweight local dictionary" scope.
// Returns `complete: false` whenever a substantive (non-stopword) word had
// no translation, so callers can tell a genuinely full Romanian rendering
// apart from a partial one that would otherwise mix the two languages
// mid-string (e.g. "Cablu Y-Raise") — see translateExerciseName() below.
function substituteWords(text) {
  let result = text;
  let complete = true;
  for (const [en, ro] of PHRASE_MAP) {
    result = result.replace(new RegExp(`\\b${en}\\b`, "gi"), ro);
  }
  result = result.replace(/[A-Za-zĂÂÎȘȚăâîșț]+/g, (word) => {
    const mapped = WORD_MAP[word.toLowerCase()];
    if (!mapped) {
      if (!STOPWORDS_OK.has(word.toLowerCase())) complete = false;
      return word;
    }
    // Preserve a leading capital if the original word had one (start of the
    // name, or a proper-noun-styled entry from wger).
    return word[0] === word[0].toUpperCase() ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
  });
  return { text: result, complete };
}

/** Translates an exercise name for display. Returns the original English
 * name unchanged outside Romanian — callers should still send the untouched
 * original to the API (this never mutates the value that gets logged).
 *
 * A partial word-by-word substitution (some words translated, some left in
 * English) reads as a broken language mix rather than a helpful hint, so
 * anything short of a full curated match or a fully-covered substitution
 * falls back to the clean original English name instead of a hybrid. */
export function translateExerciseName(name, lang) {
  if (lang !== "ro" || !name) return name;
  const exact = EXACT_NAME_MAP[lowerTrim(name)];
  if (exact) return exact;
  const { text, complete } = substituteWords(name);
  return complete ? text : name;
}

export function translateCategory(category, lang) {
  if (lang !== "ro" || !category) return category;
  return CATEGORY_MAP[lowerTrim(category)] || category;
}

export function translateMuscle(muscle, lang) {
  if (lang !== "ro" || !muscle) return muscle;
  return MUSCLE_MAP[lowerTrim(muscle)] || muscle;
}

// ---------------------------------------------------------------------------
// Query normalization — the other translation direction from everything
// above. backend/routers/discover.py's exercise search is English-only by
// deliberate design (see this file's header comment) and matches
// token-for-token against wger's English names, so a Romanian-typed query
// ("genuflexiune cu bara", "flexii biceps") would otherwise find nothing —
// not because the exercise isn't in the catalog, just because the search
// box and the catalog don't speak the same language yet. This reuses the
// exact same EXACT_NAME_MAP/PHRASE_MAP/WORD_MAP dictionaries in reverse
// (RO -> EN) to translate what's recognizable before the query ever reaches
// the backend, and leaves anything unrecognized as-is — a Romanian lifter
// typing an already-English term ("hip thrust") or a name outside this
// dictionary's small curated coverage still passes through unharmed, just
// like PHRASE_MAP/WORD_MAP's forward direction already does.
// ---------------------------------------------------------------------------

// Diacritic-insensitive on purpose: a query typed on a non-Romanian
// keyboard/phone layout ("genuflexiuni" without the ă/â/î/ș/ț) is extremely
// common and shouldn't be a dead end — every dictionary key below is
// matched against this same folded form on both sides.
function stripDiacritics(s) {
  return (s || "")
    .replace(/[ăâ]/g, "a")
    .replace(/[î]/g, "i")
    .replace(/[ș]/g, "s")
    .replace(/[ț]/g, "t");
}
function foldForMatch(s) {
  return stripDiacritics((s || "").trim().toLowerCase());
}

// Built once at module load: EXACT_NAME_MAP inverted (RO -> EN), keyed by
// its folded RO text, for a whole-phrase curated match.
const REVERSE_EXACT_MAP = Object.fromEntries(
  Object.entries(EXACT_NAME_MAP).map(([en, ro]) => [foldForMatch(ro), en]),
);

// PHRASE_MAP inverted, longest RO phrase first so e.g. "romanian deadlift"'s
// own phrase wins over the plainer "deadlift" word match below it.
const REVERSE_PHRASE_MAP = PHRASE_MAP.map(([en, ro]) => [foldForMatch(ro), en]).sort((a, b) => b[0].length - a[0].length);

// WORD_MAP inverted. Several English words share one Romanian translation
// (e.g. "extension" and "pushdown" both read as "extensie" in this
// dictionary) — first entry wins on collision, which is fine here: this
// only feeds a best-effort search-box normalization, not a display string,
// and the backend's fuzzy matching (see exercise_cache_service.py) tolerates
// picking the "wrong" but related English synonym.
const REVERSE_WORD_MAP = {};
for (const [en, ro] of Object.entries(WORD_MAP)) {
  const key = foldForMatch(ro);
  if (!(key in REVERSE_WORD_MAP)) REVERSE_WORD_MAP[key] = en;
}

// A folded RO word not found verbatim in REVERSE_WORD_MAP might just be a
// different inflection of one that is (Romanian plurals/cases change a
// word's ending, not its start — "genuflexiune" -> "genuflexiuni",
// "presă" -> "prese") — not real stemming, just a conservative
// longest-shared-prefix scan over this small (~40-entry) dictionary,
// requiring the shared prefix to cover all but the last couple characters
// of the shorter word so an unrelated word can't accidentally match.
function reverseWordLookup(word) {
  if (REVERSE_WORD_MAP[word]) return REVERSE_WORD_MAP[word];
  if (word.length < 4) return null;
  let best = null;
  let bestShared = 0;
  for (const key of Object.keys(REVERSE_WORD_MAP)) {
    if (key.length < 4) continue;
    const minLen = Math.min(key.length, word.length);
    let shared = 0;
    while (shared < minLen && key[shared] === word[shared]) shared++;
    if (shared >= minLen - 2 && shared > bestShared) {
      best = REVERSE_WORD_MAP[key];
      bestShared = shared;
    }
  }
  return best;
}

// Romanian prepositions/articles with no English equivalent worth sending —
// nothing in WORD_MAP/PHRASE_MAP ever translates to these, so an untouched
// one is just noise the backend's per-token fuzzy score would otherwise
// have to average in (see exercise_cache_service.py's _name_match_score),
// dragging down an otherwise-good match for no benefit. Dropped, not
// translated to anything.
const FILLER_WORDS_RO = new Set(["cu", "la", "de", "din", "pe", "in", "si", "a", "al", "ale", "un", "o"]);

/** Best-effort translation of a user-typed search query into the English
 * terms the backend's exercise search actually matches against. A no-op
 * outside Romanian, and a no-op for any word this dictionary doesn't
 * recognize (left exactly as typed, so English/loanword terms and typos
 * still reach the backend's own fuzzy matching untouched). */
export function translateQueryToEnglish(query, lang) {
  if (lang !== "ro" || !query) return query;
  const folded = foldForMatch(query);
  if (!folded) return query;
  const exact = REVERSE_EXACT_MAP[folded];
  if (exact) return exact;

  let result = ` ${folded} `;
  for (const [roPhrase, en] of REVERSE_PHRASE_MAP) {
    result = result.split(` ${roPhrase} `).join(` ${en} `);
  }
  const translated = result
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => reverseWordLookup(word) || word)
    .filter((word) => !FILLER_WORDS_RO.has(word))
    .join(" ");
  // Every word was a filler/unrecognized-but-dropped term (rare, but
  // possible for a very short query) — fall back to the original text
  // rather than sending the backend an empty query, which would silently
  // switch from "search" to "show the curated popular list" behavior.
  return translated || query;
}
