// Lazy-loaded i18n chunk for the Meal Suggester sheet (js/mealSuggester.js)
// — perf audit Phase 2. Covers both namespaces it owns: mealSuggester (the
// sheet's own copy) and nutrients (the nutrient-facts labels its results
// list renders). Registered into the live dictionary via i18n.js's
// registerDictionary() the first time the sheet is opened (see app.js's
// loadMealSuggesterModule()) — reachable from the FAB's "Suggest a meal"
// option AND from Damage Control's own suggestion callback, both funnel
// through that one loader. Generated from i18n.js's original single
// dictionary — content is byte-identical to what these namespaces used to
// contain there, verified via a deep-equal check against the pre-split
// dictionary before this file was written; if you're hand-editing after
// this point, that guarantee no longer holds automatically, so keep en/ro
// in exact key-parity by hand (same discipline the original single-file
// dictionary always required — see i18n.js's own registerDictionary() for
// the automated check that now catches a drift here at load time instead
// of only by manual review).

export const en = {
  "mealSuggester": {
    "title": "Suggest a meal",
    "remainingHeading": "Left today",
    "filtersSectionLabel": "Filters",
    "filtersAriaLabel": "Filter meal suggestions",
    "filterHighProtein": "High Protein",
    "filterLowFat": "Low Fat",
    "filterBudget": "Budget",
    "filterFastPrep": "Fast Prep",
    "getIdeasBtn": "Get ideas",
    "loadingBtn": "Finding ideas…",
    "loadingStage1": "Consulting the AI chef…",
    "loadingStage2": "Balancing your macros…",
    "loadingStage3": "Finding the perfect meal…",
    "emptyHint": "Pick a filter (or not) and tap Get ideas.",
    "noResults": "Couldn't come up with anything that fits — try adjusting your filters.",
    "errorGeneric": "Could not get meal suggestions right now. Please try again.",
    "logBtn": "Log this Meal",
    "loggedBtn": "Logged",
    "needsWeight": "Enter a portion weight before logging",
    "weightAriaLabel": "Portion weight in grams for {{name}}",
    "ingredientsLabel": "Ingredients ({{count}})"
  },
  "nutrients": {
    "moreLabel": "More nutrients",
    "sugar": "Sugar",
    "sodium": "Sodium"
  }
};

export const ro = {
  "mealSuggester": {
    "title": "Sugerează o masă",
    "remainingHeading": "Rămas astăzi",
    "filtersSectionLabel": "Filtre",
    "filtersAriaLabel": "Filtrează sugestiile de mese",
    "filterHighProtein": "Bogat în Proteine",
    "filterLowFat": "Puține Grăsimi",
    "filterBudget": "Buget Redus",
    "filterFastPrep": "Preparare Rapidă",
    "getIdeasBtn": "Arată-mi idei",
    "loadingBtn": "Caut idei…",
    "loadingStage1": "Consult bucătarul AI…",
    "loadingStage2": "Echilibrez macronutrienții…",
    "loadingStage3": "Găsesc masa perfectă…",
    "emptyHint": "Alege un filtru (sau nu) și apasă Arată-mi idei.",
    "noResults": "Nu am găsit nimic potrivit — încearcă alte filtre.",
    "errorGeneric": "Nu am putut obține sugestii de mese acum. Încearcă din nou.",
    "logBtn": "Înregistrează masa",
    "loggedBtn": "Înregistrat",
    "needsWeight": "Introdu greutatea porției înainte de a înregistra",
    "weightAriaLabel": "Greutatea porției în grame pentru {{name}}",
    "ingredientsLabel": "Ingrediente ({{count}})"
  },
  "nutrients": {
    "moreLabel": "Mai mulți nutrienți",
    "sugar": "Zahăr",
    "sodium": "Sodiu"
  }
};
