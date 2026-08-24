// Lazy-loaded i18n chunk for the Progress tab (js/progress.js) — perf audit
// Phase 2. Covers all four namespaces progress.js owns: progress (the tab's
// own copy), cardInfo (the "About this card" info-sheet copy — see
// js/progress.js's CARD_INFO + #card-info-sheet-overlay in index.html for
// where these render), milestones, and measurements. Registered into the
// live dictionary via i18n.js's registerDictionary() the first time the
// Progress tab is opened (see app.js's loadProgressModule()), not present
// in the always-loaded core bundle. Generated from i18n.js's original
// single dictionary — content is byte-identical to what these namespaces
// used to contain there, verified via a deep-equal check against the
// pre-split dictionary before this file was written; if you're hand-editing
// after this point, that guarantee no longer holds automatically, so keep
// en/ro in exact key-parity by hand (same discipline the original
// single-file dictionary always required — see i18n.js's own
// registerDictionary() for the automated check that now catches a drift
// here at load time instead of only by manual review).

export const en = {
  "progress": {
    "weightSectionTitle": "Body weight",
    "weightSectionMicro": "Log weigh-ins, see your trend.",
    "weightSectionInfoAria": "About body weight",
    "weightInputLabel": "Weight (kg)",
    "weightInputPlaceholder": "e.g. 78.5",
    "logWeightBtn": "Log weight",
    "weightEmpty": "No weigh-ins yet. Log your weight to start tracking your trend.",
    "weightChartTitle": "Weight trend",
    "trendSectionTitle": "This week",
    "groupSuggestions": "From your saved meals",
    "groupHistory": "History",
    "groupBody": "Body",
    "groupTraining": "Training",
    "groupAnalysis": "Analysis",
    "groupProjection": "Projection",
    "muscleHeatmapTitle": "Muscle Heatmap",
    "muscleHeatmapInfoAria": "About the muscle heatmap",
    "muscleHeatmapEmpty": "Log a workout to see which muscles you've trained this week.",
    "muscleHeatmapSets": "{{count}} sets",
    "muscleHeatmapNeglected": "Not trained this week: {{names}}",
    "muscleGroupChest": "Chest",
    "muscleGroupBack": "Back",
    "muscleGroupLegs": "Legs",
    "muscleGroupShoulders": "Shoulders",
    "muscleGroupArms": "Arms",
    "muscleGroupCore": "Core",
    "groupAchievements": "Achievements",
    "streakLabel": "day streak",
    "streakInfoAria": "About your streak",
    "streakNone": "No streak yet — stay within your calorie goal to start one",
    "waterStreakLabel": "{{days}}-day water streak",
    "streakFreezeActive": "Freeze active — one missed day won't break your streak",
    "streakFreezeReady": "Freeze ready — protects your streak if you miss a day",
    "streakFreezeCooldown": "Next freeze in {{days}}d",
    "consistencyScore": "Consistency {{score}}/100",
    "targetReviewOver": "You've been consistently over your calorie goal for {{count}} days — want to review your targets?",
    "targetReviewUnder": "You've been consistently under your calorie goal for {{count}} days — want to review your targets?",
    "targetReviewOpen": "Review targets",
    "targetReviewDismiss": "Not now",
    "calorieTrendTitle": "Calories vs target",
    "calorieTrendMicro": "This week vs. your target.",
    "calorieTrendInfoAria": "About calories vs target",
    "macroHeatmapTitle": "Macro consistency",
    "macroHeatmapSubtitle": "Your weekly macro average.",
    "macroHeatmapInfoAria": "About macro consistency",
    "macroAvgOfTarget": "{{avg}}g avg of {{target}}g",
    "macroHitDays": "{{hit}}/{{total}} days on target",
    "macroConsistencyStat": "{{pct}}% avg",
    "macroInsightGood": "Solid macro consistency this week — keep it up.",
    "macroInsightWeak": "{{macro}} is your biggest opportunity this week — on target only {{hit}}/{{total}} days.",
    "macroInsightOverTop": "{{macro}} ran over target most days, mostly from {{food}} — that's the easiest place to dial back.",
    "retentionNote": "Showing the last {{days}} days — older logs are cleared automatically to save storage.",
    "avgLabel": "Avg",
    "legendUnder": "Under target",
    "legendOver": "Over target",
    "legendTarget": "Target",
    "legendRawWeight": "Raw weigh-ins",
    "legendSmoothedWeight": "Smoothed trend",
    "weightTrendRate": "{{rate}} kg/wk avg",
    "vsLast": "vs last",
    "noChange": "no change",
    "dayHistoryTitle": "Daily history",
    "dayHistoryMicro": "Tap a day for the full breakdown.",
    "dayHistoryInfoAria": "About daily history",
    "today": "Today",
    "noLogsShort": "No logs",
    "topFoodsTitle": "Top Caloric Contributors",
    "topFoodsSubtitle": "Ranked by calorie share.",
    "topFoodsInfoAria": "About top caloric contributors",
    "topFoodsEmpty": "Nothing logged in this window yet.",
    "topFoodsPct": "{{pct}}% of calories",
    "topFoodsCount": "logged {{count}}×",
    "topFoodsAvg": "~{{avg}} kcal/serving",
    "topFoodsMacroBarLabel": "{{protein}}g protein, {{carbs}}g carbs, {{fats}}g fats"
  },
  "cardInfo": {
    "streak": {
      "title": "Your Streak",
      "body": "Counts the consecutive days you logged food and stayed close to your calorie target — roughly within 10%. It's about consistency, not perfection: one logged day still counts even if the number wasn't exact. A missed day resets it, unless a Streak Freeze covers you."
    },
    "calories": {
      "title": "Calories vs. Target",
      "body": "Compares what you actually ate each day this week to your daily calorie target. Bars above the line mean you went over; below means you stayed under. Look for patterns across the week — like weekends running high — rather than judging any single day."
    },
    "macros": {
      "title": "Macro Consistency",
      "body": "Macros are the three nutrients that make up your calories — protein, carbs, and fats. This shows how close your weekly averages landed to your targets. Protein is usually worth watching closest, since it's what your body uses to build and repair muscle."
    },
    "history": {
      "title": "Daily History",
      "body": "A day-by-day record of everything you've logged recently. Tap any day to open its full breakdown — every food, every gram, every macro. It's the fastest way to check exactly what you ate on a given day."
    },
    "adaptive": {
      "title": "Adaptive Goals",
      "body": "Your target was set at a point in time, but your body keeps changing as you log weight. This checks your recent weight trend against your goal and suggests updated targets when they'd genuinely help. Nothing changes automatically — you choose whether to apply it."
    },
    "foods": {
      "title": "Top Caloric Contributors",
      "body": "The foods that made up the biggest share of your calories recently, ranked highest first. It's a quick way to see what's really driving your intake — sometimes it's obvious, sometimes a small daily habit adds up more than you'd expect."
    },
    "workout": {
      "title": "Workout Diary",
      "body": "A full log of your training sessions — sets, reps, weight, and how hard each one felt. Reviewing it over time is how you tell whether you're actually getting stronger, instead of just guessing."
    },
    "muscleHeatmap": {
      "title": "Muscle Heatmap",
      "body": "How many sets each muscle group got over the last 7 days, based on the sets you've logged in the Workout Diary. A quick way to spot a muscle group you've been neglecting before it turns into a lopsided routine."
    },
    "forecast": {
      "title": "Weight Forecast",
      "body": "Using your recent weight trend and estimated energy balance, this projects roughly where your weight is headed over the coming weeks. It's a forecast, not a promise — trust the direction more than any single number, since normal day-to-day swings are expected."
    },
    "weight": {
      "title": "Body Weight",
      "body": "Log your weight regularly and this tracks the trend over time — smoothed out so normal daily swings from water, sodium, or digestion don't look like real progress or setbacks. The smoothed line is what actually matters, not any one weigh-in."
    },
    "measurements": {
      "title": "Body Measurements",
      "body": "Track waist, chest, arms, and other spots with a tape measure. Measurements can reveal changes in shape that the scale alone misses — especially useful when your weight holds steady but your body composition is still shifting."
    },
    "achievements": {
      "title": "Milestones",
      "body": "Small rewards for showing up consistently — logging streaks, weigh-in habits, and other signs you're sticking with it. They're not a scorecard to obsess over, just a nod to the fact that consistency is what actually gets results."
    }
  },
  "milestones": {
    "title": "Milestones",
    "sectionMicro": "Earned through consistency.",
    "sectionInfoAria": "About milestones",
    "earned": "Earned",
    "notYetEarned": "Not yet earned",
    "unlockedToast": "Achievement unlocked: {{name}}",
    "tierBronze": "Bronze",
    "tierSilver": "Silver",
    "tierGold": "Gold",
    "tierPlatinum": "Platinum",
    "firstLog": "First Log",
    "firstLogDesc": "Log your first meal or snack",
    "streak3": "3-Day Streak",
    "streak3Desc": "Log food 3 days in a row",
    "streak7": "Perfect Week",
    "streak7Desc": "Log food every day for a full week — the longest streak this app tracks",
    "firstWeighIn": "First Weigh-In",
    "firstWeighInDesc": "Log your body weight for the first time",
    "trackingPro": "Tracking Pro",
    "trackingProDesc": "Log your weight 20 times",
    "weightVeteran": "Weigh-In Veteran",
    "weightVeteranDesc": "Log your weight 50 times — the more data, the clearer the trend",
    "bodyTracker": "Body Tracker",
    "bodyTrackerDesc": "Log 5 body measurements, like waist or arms",
    "precisionTracker": "Precision Tracker",
    "precisionTrackerDesc": "Log 20 body measurements",
    "mealPrepper": "Meal Prepper",
    "mealPrepperDesc": "Save 5 meals or products as favorites",
    "mealPrepMaster": "Meal Prep Master",
    "mealPrepMasterDesc": "Save 15 meals or products as favorites",
    "firstWorkout": "First Workout",
    "firstWorkoutDesc": "Log your first training session",
    "consistentLifter": "Consistent Lifter",
    "consistentLifterDesc": "Log 10 training sessions",
    "ironVeteran": "Iron Veteran",
    "ironVeteranDesc": "Log 50 training sessions",
    "heavyHitter": "Heavy Hitter",
    "heavyHitterDesc": "Lift a combined total of 10,000 kg across every logged set",
    "wellRounded": "All-Rounder",
    "wellRoundedDesc": "Keep a 3-day streak while tracking weight, measurements, and workouts",
    "balancedWeek": "Balanced Week",
    "balancedWeekDesc": "Hit your protein target while keeping fats in check for 5 days",
    "fiberStreak": "Fiber Streak",
    "fiberStreakDesc": "Go over your fiber target 3 days in a row",
    "ollieFirstHello": "First Hello",
    "ollieFirstHelloDesc": "Say hi to Ollie for the first time — give him a tap!",
    "ollieChef": "Ollie's Chef",
    "ollieChefDesc": "Log your first meal to feed Ollie",
    "ollieHydration": "Hydration Hero",
    "ollieHydrationDesc": "Keep Ollie hydrated 3 days in a row by hitting your water target",
    "ollieDevotedFriend": "Devoted Friend",
    "ollieDevotedFriendDesc": "Tap and interact with Ollie 25 times",
    "olliePerfectCaretaker": "Perfect Caretaker",
    "olliePerfectCaretakerDesc": "Keep Ollie's hearts maxed out for 5 days in a row"
  },
  "measurements": {
    "sectionTitle": "Body measurements",
    "sectionMicro": "Track waist, chest, and arms.",
    "sectionInfoAria": "About body measurements",
    "newBtn": "+ Add",
    "filterLabel": "Show",
    "filterAll": "All measurements",
    "empty": "No measurements logged yet. Add your first one (e.g. waist, chest, arm) to start tracking.",
    "addTitle": "Add measurement",
    "editTitle": "Edit measurement",
    "nameLabel": "Measurement name",
    "namePlaceholder": "e.g. Waist",
    "valueLabel": "Value",
    "unitLabel": "Unit",
    "dateLabel": "Date",
    "timeLabel": "Time",
    "saveBtn": "Save measurement"
  }
};

export const ro = {
  "progress": {
    "weightSectionTitle": "Greutate corporală",
    "weightSectionMicro": "Înregistrează și vezi tendința.",
    "weightSectionInfoAria": "Despre greutatea corporală",
    "weightInputLabel": "Greutate (kg)",
    "weightInputPlaceholder": "ex. 78.5",
    "logWeightBtn": "Înregistrează greutatea",
    "weightEmpty": "Nicio greutate înregistrată încă. Înregistrează-ți greutatea pentru a începe să urmărești tendința.",
    "weightChartTitle": "Tendință greutate",
    "trendSectionTitle": "Săptămâna aceasta",
    "groupSuggestions": "Din mesele tale salvate",
    "groupHistory": "Istoric",
    "groupBody": "Corp",
    "groupTraining": "Antrenament",
    "groupAnalysis": "Analiză",
    "groupProjection": "Proiecție",
    "muscleHeatmapTitle": "Harta mușchilor",
    "muscleHeatmapInfoAria": "Despre harta mușchilor",
    "muscleHeatmapEmpty": "Înregistrează un antrenament ca să vezi ce mușchi ai lucrat săptămâna aceasta.",
    "muscleHeatmapSets": "{{count}} seturi",
    "muscleHeatmapNeglected": "Nelucrate săptămâna aceasta: {{names}}",
    "muscleGroupChest": "Piept",
    "muscleGroupBack": "Spate",
    "muscleGroupLegs": "Picioare",
    "muscleGroupShoulders": "Umeri",
    "muscleGroupArms": "Brațe",
    "muscleGroupCore": "Abdomen",
    "groupAchievements": "Realizări",
    "streakLabel": "zile la rând",
    "streakInfoAria": "Despre seria ta",
    "streakNone": "Niciun streak încă — respectă obiectivul caloric pentru a începe unul",
    "waterStreakLabel": "{{days}} zile la rând cu apă",
    "streakFreezeActive": "Îngheț activ — o zi ratată nu îți va întrerupe seria",
    "streakFreezeReady": "Îngheț pregătit — îți protejează seria dacă ratezi o zi",
    "streakFreezeCooldown": "Următorul îngheț în {{days}}z",
    "consistencyScore": "Consecvență {{score}}/100",
    "targetReviewOver": "Ai fost constant peste obiectivul caloric timp de {{count}} zile — vrei să-ți revizuiești obiectivele?",
    "targetReviewUnder": "Ai fost constant sub obiectivul caloric timp de {{count}} zile — vrei să-ți revizuiești obiectivele?",
    "targetReviewOpen": "Revizuiește obiectivele",
    "targetReviewDismiss": "Nu acum",
    "calorieTrendTitle": "Calorii vs obiectiv",
    "calorieTrendMicro": "Săptămâna aceasta vs. obiectiv.",
    "calorieTrendInfoAria": "Despre calorii vs obiectiv",
    "macroHeatmapTitle": "Consecvență macro",
    "macroHeatmapSubtitle": "Media ta săptămânală de macro.",
    "macroHeatmapInfoAria": "Despre consecvența macro",
    "macroAvgOfTarget": "{{avg}}g medie din {{target}}g",
    "macroHitDays": "{{hit}}/{{total}} zile în limită",
    "macroConsistencyStat": "{{pct}}% medie",
    "macroInsightGood": "Consecvență solidă a macronutrienților săptămâna aceasta — așa continuă.",
    "macroInsightWeak": "{{macro}} este cea mai mare oportunitate săptămâna aceasta — în limită doar {{hit}}/{{total}} zile.",
    "macroInsightOverTop": "{{macro}} a depășit obiectivul în majoritatea zilelor, mai ales din {{food}} — de acolo e cel mai simplu de redus.",
    "retentionNote": "Se afișează ultimele {{days}} zile — înregistrările mai vechi sunt șterse automat pentru economisirea spațiului.",
    "avgLabel": "Medie",
    "legendUnder": "Sub obiectiv",
    "legendOver": "Peste obiectiv",
    "legendTarget": "Obiectiv",
    "legendRawWeight": "Cântăriri reale",
    "legendSmoothedWeight": "Tendință netezită",
    "weightTrendRate": "{{rate}} kg/săpt medie",
    "vsLast": "față de ultima",
    "noChange": "fără schimbare",
    "dayHistoryTitle": "Istoric zilnic",
    "dayHistoryMicro": "Atinge o zi pentru detalii complete.",
    "dayHistoryInfoAria": "Despre istoricul zilnic",
    "today": "Azi",
    "noLogsShort": "Fără înregistrări",
    "topFoodsTitle": "Top Contribuitori Calorici",
    "topFoodsSubtitle": "În ordinea cotei calorice.",
    "topFoodsInfoAria": "Despre topul contribuitorilor calorici",
    "topFoodsEmpty": "Nimic înregistrat în această perioadă încă.",
    "topFoodsPct": "{{pct}}% din calorii",
    "topFoodsCount": "înregistrat de {{count}}×",
    "topFoodsAvg": "~{{avg}} kcal/porție",
    "topFoodsMacroBarLabel": "{{protein}}g proteine, {{carbs}}g carbohidrați, {{fats}}g grăsimi"
  },
  "cardInfo": {
    "streak": {
      "title": "Seria Ta",
      "body": "Numără zilele consecutive în care ai înregistrat mâncarea și te-ai încadrat aproape de ținta de calorii — cam în limita a 10%. Contează constanța, nu perfecțiunea: o zi înregistrată contează chiar dacă numărul n-a fost exact. O zi ratată o resetează, dacă nu ai un Îngheț de serie care să te acopere."
    },
    "calories": {
      "title": "Calorii vs. Țintă",
      "body": "Compară ce ai mâncat efectiv în fiecare zi din această săptămână cu ținta ta zilnică de calorii. Barele peste linie înseamnă că ai depășit ținta; sub linie, că te-ai încadrat. Caută tipare de-a lungul săptămânii — de exemplu weekenduri mai încărcate — nu judeca o singură zi."
    },
    "macros": {
      "title": "Consecvență Macro",
      "body": "Macronutrienții sunt cele trei elemente care alcătuiesc caloriile — proteine, carbohidrați și grăsimi. Aici vezi cât de aproape au fost mediile tale săptămânale de ținte. Proteina merită cea mai multă atenție, fiindcă e ceea ce corpul folosește pentru a construi și repara mușchiul."
    },
    "history": {
      "title": "Istoric Zilnic",
      "body": "O evidență zi de zi a tot ce ai înregistrat recent. Atinge orice zi pentru a vedea detaliile complete — fiecare aliment, fiecare gram, fiecare macronutrient. E cel mai rapid mod de a afla exact ce ai mâncat într-o anumită zi."
    },
    "adaptive": {
      "title": "Obiective Adaptive",
      "body": "Ținta ta a fost stabilită la un moment dat, dar corpul tău continuă să se schimbe pe măsură ce înregistrezi greutatea. Acest card verifică trendul recent al greutății față de obiectivul tău și sugerează ținte actualizate atunci când chiar ar ajuta. Nimic nu se schimbă automat — tu alegi dacă aplici."
    },
    "foods": {
      "title": "Top Contribuitori Calorici",
      "body": "Alimentele care au reprezentat cea mai mare parte din caloriile tale recente, listate de la cea mai mare pondere. E un mod rapid de a vedea ce îți influențează cu adevărat aportul caloric — uneori e evident, alteori un obicei mic se adună mai mult decât ai crede."
    },
    "workout": {
      "title": "Jurnal de Antrenament",
      "body": "O evidență completă a sesiunilor tale de antrenament — seturi, repetări, greutate și cât de greu a fost fiecare. Recitind-o în timp îți dai seama dacă chiar devii mai puternic, nu doar presupui."
    },
    "muscleHeatmap": {
      "title": "Harta Mușchilor",
      "body": "Câte seturi a primit fiecare grupă musculară în ultimele 7 zile, pe baza seturilor înregistrate în Jurnalul de antrenament. Un mod rapid de a observa o grupă musculară neglijată înainte să devină o rutină dezechilibrată."
    },
    "forecast": {
      "title": "Prognoză Greutate",
      "body": "Folosind trendul recent al greutății și balanța energetică estimată, acest card proiectează aproximativ încotro se îndreaptă greutatea ta în săptămânile următoare. E o estimare, nu o promisiune — ai încredere mai mult în direcție decât într-un singur număr, fiindcă fluctuațiile zilnice normale sunt de așteptat."
    },
    "weight": {
      "title": "Greutate Corporală",
      "body": "Înregistrează-ți greutatea regulat, iar acest card urmărește trendul în timp — netezit, astfel încât fluctuațiile zilnice normale din apă, sodiu sau digestie să nu pară progres real sau un pas înapoi. Linia netezită contează cu adevărat, nu o singură cântărire."
    },
    "measurements": {
      "title": "Măsurători Corporale",
      "body": "Urmărește talia, pieptul, brațele și alte zone cu o bandă metrică. Măsurătorile pot arăta schimbări de formă pe care cântarul singur nu le surprinde — util mai ales când greutatea rămâne stabilă, dar compoziția corporală încă se schimbă."
    },
    "achievements": {
      "title": "Realizări",
      "body": "Recompense mici pentru constanță — serii de înregistrări, obiceiul de a te cântări și alte semne că te ții de plan. Nu sunt un scor de care să te agăți, ci doar o recunoaștere a faptului că, de fapt, constanța aduce rezultate."
    }
  },
  "milestones": {
    "title": "Realizări",
    "sectionMicro": "Câștigate prin consecvență.",
    "sectionInfoAria": "Despre realizări",
    "earned": "Obținut",
    "notYetEarned": "Neobținut încă",
    "unlockedToast": "Realizare deblocată: {{name}}",
    "tierBronze": "Bronz",
    "tierSilver": "Argint",
    "tierGold": "Aur",
    "tierPlatinum": "Platină",
    "firstLog": "Prima înregistrare",
    "firstLogDesc": "Înregistrează prima masă sau gustare",
    "streak3": "Serie de 3 zile",
    "streak3Desc": "Înregistrează mese 3 zile la rând",
    "streak7": "Săptămână perfectă",
    "streak7Desc": "Înregistrează mese în fiecare zi timp de o săptămână întreagă — cea mai lungă serie urmărită de aplicație",
    "firstWeighIn": "Prima cântărire",
    "firstWeighInDesc": "Înregistrează-ți greutatea pentru prima dată",
    "trackingPro": "Expert în monitorizare",
    "trackingProDesc": "Înregistrează-ți greutatea de 20 de ori",
    "weightVeteran": "Veteran la cântărire",
    "weightVeteranDesc": "Înregistrează-ți greutatea de 50 de ori — cu cât mai multe date, cu atât tendința e mai clară",
    "bodyTracker": "Monitor corporal",
    "bodyTrackerDesc": "Înregistrează 5 măsurători corporale, precum talia sau brațele",
    "precisionTracker": "Monitorizare de precizie",
    "precisionTrackerDesc": "Înregistrează 20 de măsurători corporale",
    "mealPrepper": "Meal Prepper",
    "mealPrepperDesc": "Salvează 5 mese sau produse ca favorite",
    "mealPrepMaster": "Maestru meal prep",
    "mealPrepMasterDesc": "Salvează 15 mese sau produse ca favorite",
    "firstWorkout": "Primul antrenament",
    "firstWorkoutDesc": "Înregistrează primul tău antrenament",
    "consistentLifter": "Sportiv constant",
    "consistentLifterDesc": "Înregistrează 10 sesiuni de antrenament",
    "ironVeteran": "Veteran de fier",
    "ironVeteranDesc": "Înregistrează 50 de sesiuni de antrenament",
    "heavyHitter": "Greutate grea",
    "heavyHitterDesc": "Ridică un total combinat de 10.000 kg din toate seturile înregistrate",
    "wellRounded": "Complet",
    "wellRoundedDesc": "Menține o serie de 3 zile în timp ce urmărești greutatea, măsurătorile și antrenamentele",
    "balancedWeek": "Săptămână echilibrată",
    "balancedWeekDesc": "Atinge-ți obiectivul de proteine ținând grăsimile sub control timp de 5 zile",
    "fiberStreak": "Serie de fibre",
    "fiberStreakDesc": "Depășește-ți obiectivul de fibre 3 zile la rând",
    "ollieFirstHello": "Primul salut",
    "ollieFirstHelloDesc": "Salută-l pe Ollie pentru prima dată — atinge-l!",
    "ollieChef": "Bucătarul lui Ollie",
    "ollieChefDesc": "Înregistrează prima masă pentru a-l hrăni pe Ollie",
    "ollieHydration": "Erou al hidratării",
    "ollieHydrationDesc": "Menține-l pe Ollie hidratat 3 zile la rând, atingându-ți obiectivul de apă",
    "ollieDevotedFriend": "Prieten devotat",
    "ollieDevotedFriendDesc": "Atinge și interacționează cu Ollie de 25 de ori",
    "olliePerfectCaretaker": "Îngrijitor perfect",
    "olliePerfectCaretakerDesc": "Menține inimile lui Ollie la maximum timp de 5 zile la rând"
  },
  "measurements": {
    "sectionTitle": "Măsurători corporale",
    "sectionMicro": "Urmărește talia, pieptul, brațele.",
    "sectionInfoAria": "Despre măsurătorile corporale",
    "newBtn": "+ Adaugă",
    "filterLabel": "Arată",
    "filterAll": "Toate măsurătorile",
    "empty": "Nicio măsurătoare înregistrată încă. Adaugă prima măsurătoare (ex. talie, piept, braț) pentru a începe urmărirea.",
    "addTitle": "Adaugă măsurătoare",
    "editTitle": "Editează măsurătoarea",
    "nameLabel": "Numele măsurătorii",
    "namePlaceholder": "ex. Talie",
    "valueLabel": "Valoare",
    "unitLabel": "Unitate",
    "dateLabel": "Data",
    "timeLabel": "Ora",
    "saveBtn": "Salvează măsurătoarea"
  }
};
