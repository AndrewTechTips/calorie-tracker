# Curated, hand-authored Discover content — recipes and workout plans this
# app ships and maintains directly, as opposed to the live external-API
# proxies in routers/discover.py (wger.de for exercises, Open Food Facts for
# products). Deliberately a plain Python module, not a database table: this
# content changes by editing code and redeploying, the same way
# nutritionMath.js's target-calculator constants do on the frontend — there
# is no per-user mutation of any of it, so a table + migration would be
# unneeded ceremony for content this small and this rarely changed.
#
# Macro figures are realistic per-serving estimates (standard ingredient
# nutrition data, not measured/lab values) — same "starting point, not a lab
# result" honesty this app already applies to its own AI-scanned estimates.
# The Romanian dishes here are genuine traditional recipes (ciorbă de
# legume, mici, sarmale, papanași, etc.), not generic dishes relabeled —
# this app expects Romanian users at launch and the content should actually
# reflect that.
#
# Bilingual fields (`name`, `ingredients`, `instructions` on recipes; `name`
# and each day's `label` on workout plans) are `{"en": ..., "ro": ...}`
# dicts — routers/discover.py's `localize_recipe`/`localize_plan` picks the
# requested language before the response ever reaches a Pydantic model, so
# RecipeResult/WorkoutPlanResult themselves stay flat, single-language
# shapes and the frontend never has to juggle a bilingual object. Exercise
# names inside workout plans are deliberately left as-is in both languages —
# "Bench Press", "Deadlift" etc. are the terms Romanian gym-goers actually
# use day to day, not a literal translation gap.
#
# `icon` is a category key (see frontend/js/discover.js's ICONS map for the
# actual pictogram + accent color) — several dishes in the same family
# intentionally share an icon (e.g. every soup uses "soup"), the same way a
# recipe site groups by category art rather than commissioning one unique
# photo per dish. The point is real category-level distinction instead of
# one placeholder icon repeated across all of Discover, not a guarantee that
# no two items ever look alike.

RECIPES = [
    {
        "id": "ro-ciorba-legume",
        "icon": "soup",
        "name": {"en": "Ciorbă de legume (Romanian vegetable soup)", "ro": "Ciorbă de legume"},
        "tagline": {
            "en": "A bright, lemony broth that resets your macros without ever skimping on flavor.",
            "ro": "Un bulion citric și plin de savoare, care îți reechilibrează macronutrienții fără compromisuri.",
        },
        "tags": ["romanian", "vegetarian", "quick", "low-calorie", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Vegetable%20soup.jpg",
        "prep_minutes": 35,
        "servings": 4,
        "weight_g": 350,
        "calories": 145,
        "protein": 4,
        "carbs": 24,
        "fats": 4,
        "fiber": 6,
        "ingredients": {
            "en": [
                "2 carrots, diced",
                "1 parsnip, diced",
                "1 celery root, diced",
                "2 potatoes, diced",
                "1 onion, diced",
                "1 bell pepper, diced",
                "2 tbsp tomato paste",
                "1.5L vegetable stock",
                "Juice of 1 lemon",
                "Fresh lovage or parsley, chopped",
            ],
            "ro": [
                "2 morcovi, tăiați cubulețe",
                "1 păstârnac, tăiat cubulețe",
                "1 țelină, tăiată cubulețe",
                "2 cartofi, tăiați cubulețe",
                "1 ceapă, tăiată cubulețe",
                "1 ardei gras, tăiat cubulețe",
                "2 linguri pastă de tomate",
                "1,5L supă de legume",
                "Zeamă de la 1 lămâie",
                "Leuștean sau pătrunjel proaspăt, tocat",
            ],
        },
        "instructions": {
            "en": [
                "Sauté onion and pepper in a little oil until soft.",
                "Add carrot, parsnip, celery root and potato; cook 5 minutes.",
                "Stir in tomato paste, then add stock and simmer 25 minutes until vegetables are tender.",
                "Finish with lemon juice and fresh lovage/parsley just before serving.",
            ],
            "ro": [
                "Călește ceapa și ardeiul în puțin ulei până se înmoaie.",
                "Adaugă morcovul, păstârnacul, țelina și cartoful; gătește 5 minute.",
                "Adaugă pasta de tomate, apoi supa, și lasă la fiert 25 de minute până legumele sunt fragede.",
                "Finalizează cu zeamă de lămâie și leuștean/pătrunjel proaspăt înainte de servire.",
            ],
        },
    },
    {
        "id": "ro-mici",
        "icon": "grill",
        "name": {"en": "Mici (Romanian grilled meat rolls)", "ro": "Mici"},
        "tagline": {
            "en": "Smoky, garlic-forward and char-grilled — Romania's answer to the protein-packed cookout classic.",
            "ro": "Afumate, cu mult usturoi, rumenite la grătar — răspunsul românesc la clasicul grătarului bogat în proteine.",
        },
        "tags": ["romanian", "high-protein", "grill", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Mici%20facuti%20la%20gratar.JPG",
        "prep_minutes": 30,
        "servings": 4,
        "weight_g": 200,
        "calories": 320,
        "protein": 24,
        "carbs": 3,
        "fats": 23,
        "fiber": 0,
        "ingredients": {
            "en": [
                "500g mixed ground beef and pork",
                "3 cloves garlic, minced",
                "1 tsp baking soda",
                "1 tsp ground cumin",
                "1 tsp paprika",
                "1/2 cup beef stock",
                "Salt and pepper",
            ],
            "ro": [
                "500g carne tocată amestec vită și porc",
                "3 căței de usturoi, tocați",
                "1 linguriță bicarbonat de sodiu",
                "1 linguriță chimen măcinat",
                "1 linguriță boia",
                "1/2 cană supă de vită",
                "Sare și piper",
            ],
        },
        "instructions": {
            "en": [
                "Mix all ingredients thoroughly; rest covered in the fridge at least 4 hours (overnight is better).",
                "Shape into small finger-sized rolls.",
                "Grill over medium-high heat, turning often, until well-charred outside and cooked through, about 12-15 minutes.",
            ],
            "ro": [
                "Amestecă bine toate ingredientele; lasă la frigider acoperit minimum 4 ore (peste noapte e mai bine).",
                "Formează rulouri mici, alungite.",
                "Frige pe grătar la foc mediu-mare, întorcând des, până sunt bine rumenite la exterior și pătrunse, aprox. 12-15 minute.",
            ],
        },
    },
    {
        "id": "ro-ardei-umpluti",
        "icon": "stew",
        "name": {"en": "Ardei umpluți (stuffed peppers)", "ro": "Ardei umpluți"},
        "tagline": {
            "en": "Cozy, slow-simmered comfort food built on real protein and fiber, not just carbs.",
            "ro": "Mâncare de suflet, gătită încet, cu proteine și fibre adevărate, nu doar carbohidrați.",
        },
        "tags": ["romanian", "balanced", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Ocna%20Sibiului,%20Ardei%20umpluti.jpg",
        "prep_minutes": 55,
        "servings": 4,
        "weight_g": 350,
        "calories": 310,
        "protein": 19,
        "carbs": 28,
        "fats": 13,
        "fiber": 4,
        "ingredients": {
            "en": [
                "8 bell peppers, tops removed and cored",
                "400g ground beef or pork",
                "100g rice",
                "1 onion, finely chopped",
                "1 carrot, grated",
                "500ml tomato sauce",
                "Fresh dill and parsley",
            ],
            "ro": [
                "8 ardei grași, cu vârful tăiat și curățați de semințe",
                "400g carne tocată de vită sau porc",
                "100g orez",
                "1 ceapă, tocată mărunt",
                "1 morcov, ras",
                "500ml sos de roșii",
                "Mărar și pătrunjel proaspăt",
            ],
        },
        "instructions": {
            "en": [
                "Mix meat, rice, onion, carrot, and herbs; season well.",
                "Stuff the peppers loosely (rice expands as it cooks).",
                "Stand peppers upright in a pot, cover with tomato sauce and a little water.",
                "Simmer covered 40-45 minutes until peppers are tender and rice is cooked.",
            ],
            "ro": [
                "Amestecă carnea, orezul, ceapa, morcovul și verdețurile; condimentează bine.",
                "Umple ardeii fără să-i îndeși (orezul crește la fiert).",
                "Așază ardeii în picioare într-o oală, acoperă cu sos de roșii și puțină apă.",
                "Lasă la fiert acoperit 40-45 de minute până ardeii sunt fragezi și orezul e gătit.",
            ],
        },
    },
    {
        "id": "ro-fasole-batuta",
        "icon": "mash",
        "tagline": {
            "en": "Silky, garlicky white bean purée — deceptively simple, seriously satisfying.",
            "ro": "Piure mătăsos de fasole cu usturoi — simplu în aparență, extrem de sățios.",
        },
        "name": {"en": "Fasole bătută (Romanian mashed beans)", "ro": "Fasole bătută"},
        "tags": ["romanian", "vegetarian", "high-fiber", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Fasole%20b%C4%83tut%C4%83.jpg",
        "prep_minutes": 20,
        "servings": 4,
        "weight_g": 200,
        "calories": 210,
        "protein": 11,
        "carbs": 32,
        "fats": 5,
        "fiber": 9,
        "ingredients": {
            "en": [
                "400g cooked white beans (canned or home-cooked)",
                "2 cloves garlic",
                "2 tbsp olive oil",
                "1 onion, thinly sliced",
                "Salt, pepper, a pinch of paprika",
            ],
            "ro": [
                "400g fasole albă fiartă (din conservă sau fiartă acasă)",
                "2 căței de usturoi",
                "2 linguri ulei de măsline",
                "1 ceapă, feliată subțire",
                "Sare, piper, un praf de boia",
            ],
        },
        "instructions": {
            "en": [
                "Blend beans, garlic, and a splash of their cooking liquid until smooth; season.",
                "Fry sliced onion in olive oil until deep golden and slightly caramelized.",
                "Serve the mash topped with the fried onion and a dusting of paprika.",
            ],
            "ro": [
                "Pasează fasolea, usturoiul și puțin din zeama de fierbere până obții o pastă fină; condimentează.",
                "Prăjește ceapa feliată în ulei de măsline până e auriu-închis și ușor caramelizată.",
                "Servește pasta de fasole cu ceapa călită deasupra și un praf de boia.",
            ],
        },
    },
    {
        "id": "ro-salata-vinete",
        "icon": "salad",
        "tagline": {
            "en": "Smoky charred eggplant, whipped light — a low-calorie classic that never tastes like a diet food.",
            "ro": "Vinete pârlite pe foc, bătute ușor — un clasic sărac în calorii care nu are gust de dietă.",
        },
        "name": {"en": "Salată de vinete (eggplant salad)", "ro": "Salată de vinete"},
        "tags": ["romanian", "vegetarian", "low-calorie", "quick", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Salat%C4%83_de_vinete.jpg",
        "prep_minutes": 40,
        "servings": 4,
        "weight_g": 150,
        "calories": 120,
        "protein": 2,
        "carbs": 9,
        "fats": 9,
        "fiber": 5,
        "ingredients": {
            "en": [
                "2 large eggplants",
                "1 small onion, very finely chopped",
                "3 tbsp sunflower or olive oil",
                "Juice of 1/2 lemon",
                "Salt to taste",
            ],
            "ro": [
                "2 vinete mari",
                "1 ceapă mică, tocată foarte mărunt",
                "3 linguri ulei de floarea-soarelui sau măsline",
                "Zeamă de la 1/2 lămâie",
                "Sare, după gust",
            ],
        },
        "instructions": {
            "en": [
                "Char eggplants directly over a flame or under a hot broiler until the skin blisters and flesh softens, about 20-25 minutes.",
                "Peel, drain excess liquid, and finely chop or mash the flesh.",
                "Beat in oil gradually (like a mayonnaise), then stir in onion, lemon juice, and salt.",
            ],
            "ro": [
                "Frige vinetele direct pe flacără sau la grill până pielea se bășică și miezul se înmoaie, aprox. 20-25 minute.",
                "Curăță de coajă, scurge de zeamă și toacă mărunt sau pasează miezul.",
                "Încorporează uleiul treptat (ca la maioneză), apoi adaugă ceapa, zeama de lămâie și sarea.",
            ],
        },
    },
    {
        "id": "ro-ciorba-perisoare",
        "icon": "soup",
        "tagline": {
            "en": "A hearty, tangy meatball soup that eats like comfort food and macros like a clean lunch.",
            "ro": "O ciorbă consistentă și acrișoară cu perișoare, cu gust de mâncare de suflet și macronutrienți de masă curată.",
        },
        "name": {"en": "Ciorbă de perișoare (Romanian meatball soup)", "ro": "Ciorbă de perișoare"},
        "tags": ["romanian", "balanced", "comfort-food", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Ciorb%C4%83%20cu%20peri%C8%99oare.jpg",
        "prep_minutes": 45,
        "servings": 6,
        "weight_g": 380,
        "calories": 210,
        "protein": 14,
        "carbs": 22,
        "fats": 8,
        "fiber": 4,
        "ingredients": {
            "en": [
                "300g mixed ground pork and beef",
                "60g rice",
                "1 egg",
                "1 onion, finely chopped (split between meatballs and soup)",
                "2 carrots, diced",
                "1 celery root, diced",
                "1 bell pepper, diced",
                "2L vegetable or chicken stock",
                "200ml fermented bran liquid (borș) or juice of 2 lemons",
                "Fresh lovage, dill and parsley, chopped",
            ],
            "ro": [
                "300g carne tocată amestec porc și vită",
                "60g orez",
                "1 ou",
                "1 ceapă, tocată mărunt (jumătate pentru perișoare, jumătate pentru ciorbă)",
                "2 morcovi, tăiați cubulețe",
                "1 țelină, tăiată cubulețe",
                "1 ardei gras, tăiat cubulețe",
                "2L supă de legume sau de pui",
                "200ml borș sau zeamă de la 2 lămâi",
                "Leuștean, mărar și pătrunjel proaspăt, tocate",
            ],
        },
        "instructions": {
            "en": [
                "Mix ground meat, rice, egg, and half the onion; season and shape into small meatballs.",
                "Sauté remaining onion, carrot, celery root and pepper in the soup pot for 5 minutes.",
                "Add stock, bring to a simmer, then gently drop in the meatballs and cook 20 minutes.",
                "Sour with borș or lemon juice, finish with fresh herbs.",
            ],
            "ro": [
                "Amestecă carnea tocată, orezul, oul și jumătate din ceapă; condimentează și formează perișoare mici.",
                "Călește restul de ceapă, morcovul, țelina și ardeiul în oala de ciorbă timp de 5 minute.",
                "Adaugă supa, adu la fiert, apoi introdu ușor perișoarele și fierbe 20 de minute.",
                "Acrește cu borș sau zeamă de lămâie, finalizează cu verdețuri proaspete.",
            ],
        },
    },
    {
        "id": "ro-sarmale",
        "icon": "stew",
        "tagline": {
            "en": "Romania's slow-braised signature dish — cabbage rolls built for a real bulking appetite.",
            "ro": "Preparatul emblematic al României, gătit la foc mic — sarmale pentru o poftă serioasă de masă musculară.",
        },
        "name": {"en": "Sarmale (stuffed cabbage rolls)", "ro": "Sarmale"},
        "tags": ["romanian", "balanced", "comfort-food", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Sarmale%20Romania.jpg",
        "prep_minutes": 90,
        "servings": 6,
        "weight_g": 320,
        "calories": 290,
        "protein": 16,
        "carbs": 24,
        "fats": 15,
        "fiber": 5,
        "ingredients": {
            "en": [
                "1 jar pickled cabbage leaves (or 1 fresh cabbage, blanched)",
                "400g mixed ground pork and beef",
                "80g rice",
                "1 onion, finely chopped",
                "2 tbsp tomato paste",
                "1 tsp dried thyme",
                "200g smoked bacon, diced (traditional, optional)",
                "500ml tomato sauce",
                "Sauerkraut juice or water, to cover",
            ],
            "ro": [
                "1 borcan foi de varză murată (sau 1 varză proaspătă, oparită)",
                "400g carne tocată amestec porc și vită",
                "80g orez",
                "1 ceapă, tocată mărunt",
                "2 linguri pastă de tomate",
                "1 linguriță cimbru uscat",
                "200g afumătură, tăiată cubulețe (tradițional, opțional)",
                "500ml sos de roșii",
                "Zeamă de varză sau apă, cât să acopere",
            ],
        },
        "instructions": {
            "en": [
                "Mix ground meat, rice, onion, tomato paste and thyme; season well.",
                "Wrap a spoonful of filling in each cabbage leaf, folding into small tight rolls.",
                "Layer sarmale in a pot with diced bacon between layers.",
                "Cover with tomato sauce and sauerkraut juice/water; simmer covered 1.5-2 hours until rice and cabbage are tender.",
            ],
            "ro": [
                "Amestecă carnea, orezul, ceapa, pasta de tomate și cimbrul; condimentează bine.",
                "Înfășoară câte o lingură de umplutură în fiecare foaie de varză, formând sarmale mici și strânse.",
                "Așază sarmalele în oală, în straturi, cu afumătura printre ele.",
                "Acoperă cu sos de roșii și zeamă de varză/apă; lasă la fiert acoperit 1,5-2 ore până varza și orezul sunt fragede.",
            ],
        },
    },
    {
        "id": "ro-tocanita-pui",
        "icon": "stew",
        "tagline": {
            "en": "A rustic, paprika-rich chicken stew that keeps protein high without sacrificing comfort.",
            "ro": "O tocăniță rustică de pui, bogată în boia, cu proteine multe și gust de acasă.",
        },
        "name": {"en": "Tocăniță de pui cu mămăligă (chicken stew with polenta)", "ro": "Tocăniță de pui cu mămăligă"},
        "tags": ["romanian", "high-protein", "balanced", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken%20dish%20with%20mamaliga.jpg",
        "prep_minutes": 45,
        "servings": 4,
        "weight_g": 420,
        "calories": 380,
        "protein": 32,
        "carbs": 38,
        "fats": 11,
        "fiber": 3,
        "ingredients": {
            "en": [
                "600g boneless chicken thighs",
                "1 onion, sliced",
                "1 bell pepper, sliced",
                "2 tomatoes, diced (or 200g canned)",
                "2 cloves garlic, minced",
                "1 tsp paprika",
                "200g cornmeal (for mămăligă)",
                "600ml water, for the mămăligă",
            ],
            "ro": [
                "600g pulpe de pui dezosate",
                "1 ceapă, feliată",
                "1 ardei gras, feliat",
                "2 roșii, tăiate cubulețe (sau 200g roșii din conservă)",
                "2 căței de usturoi, tocați",
                "1 linguriță boia",
                "200g mălai (pentru mămăligă)",
                "600ml apă, pentru mămăligă",
            ],
        },
        "instructions": {
            "en": [
                "Brown chicken pieces in a little oil; set aside.",
                "Sauté onion and pepper until soft, add garlic and paprika, then tomatoes.",
                "Return chicken to the pan, add a splash of water, cover and simmer 25-30 minutes until tender.",
                "Meanwhile, whisk cornmeal into boiling water, stirring constantly, until thick (about 10 minutes) — serve alongside.",
            ],
            "ro": [
                "Rumenește bucățile de pui în puțin ulei; dă-le deoparte.",
                "Călește ceapa și ardeiul până se înmoaie, adaugă usturoiul și boiaua, apoi roșiile.",
                "Adaugă puiul înapoi în tigaie, un strop de apă, acoperă și lasă la foc mic 25-30 minute până e fraged.",
                "Între timp, toarnă mălaiul în apă clocotită, amestecând continuu, până se îngroașă (aprox. 10 minute) — servește alături.",
            ],
        },
    },
    {
        "id": "ro-papanasi",
        "icon": "dessert",
        "tagline": {
            "en": "Romania's beloved fried-dough dessert — a genuine treat on a bulk day, not a compromise.",
            "ro": "Desertul românesc iubit de toți — o adevărată răsfățare într-o zi de masă musculară, nu un compromis.",
        },
        "name": {"en": "Papanași (fried cheese dumplings)", "ro": "Papanași"},
        "tags": ["romanian", "dessert", "vegetarian", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Papanasi%20cu%20cirese.jpg",
        "prep_minutes": 40,
        "servings": 4,
        "weight_g": 220,
        "calories": 410,
        "protein": 13,
        "carbs": 52,
        "fats": 16,
        "fiber": 1,
        "ingredients": {
            "en": [
                "500g cow's cheese (telemea/cottage-style), well drained",
                "2 eggs",
                "80g sugar",
                "120g flour, plus extra for shaping",
                "1 tsp baking powder",
                "Oil, for frying",
                "200g sour cream",
                "150g fruit jam (blueberry or cherry, traditional)",
            ],
            "ro": [
                "500g brânză de vaci, scursă bine",
                "2 ouă",
                "80g zahăr",
                "120g făină, plus puțină pentru modelat",
                "1 linguriță praf de copt",
                "Ulei, pentru prăjit",
                "200g smântână",
                "150g dulceață (afine sau vișine, tradițional)",
            ],
        },
        "instructions": {
            "en": [
                "Mix cheese, eggs, sugar, flour and baking powder into a soft dough.",
                "Shape into donut-like rounds with a hole in the middle, plus small balls from the trimmings.",
                "Fry in hot oil until deep golden on both sides, about 3-4 minutes per side.",
                "Serve warm topped with sour cream and jam.",
            ],
            "ro": [
                "Amestecă brânza, ouăle, zahărul, făina și praful de copt într-un aluat moale.",
                "Modelează rondele cu o gaură în mijloc, plus bile mici din resturile de aluat.",
                "Prăjește în ulei încins până sunt aurii pe ambele părți, aprox. 3-4 minute pe fiecare parte.",
                "Servește cald, cu smântână și dulceață deasupra.",
            ],
        },
    },
    {
        "id": "ro-zacusca-toast",
        "icon": "sandwich",
        "tagline": {
            "en": "Smoky roasted-vegetable spread on toast — Romania's answer to bruschetta, in under 10 minutes.",
            "ro": "Pastă afumată din legume coapte, pe pâine prăjită — răspunsul românesc la bruschetă, în sub 10 minute.",
        },
        "name": {"en": "Zacuscă on toast", "ro": "Zacuscă pe pâine prăjită"},
        "tags": ["romanian", "vegetarian", "quick", "low-calorie", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Zacusc%C4%83.jpg",
        "prep_minutes": 5,
        "servings": 1,
        "weight_g": 120,
        "calories": 180,
        "protein": 5,
        "carbs": 26,
        "fats": 6,
        "fiber": 4,
        "ingredients": {
            "en": [
                "2 slices whole-grain bread, toasted",
                "100g zacuscă (roasted vegetable spread)",
                "Fresh parsley, chopped, to garnish",
            ],
            "ro": [
                "2 felii pâine integrală, prăjite",
                "100g zacuscă",
                "Pătrunjel proaspăt, tocat, pentru garnitură",
            ],
        },
        "instructions": {
            "en": [
                "Toast the bread slices until golden.",
                "Spread zacuscă generously over each slice.",
                "Garnish with fresh parsley and serve.",
            ],
            "ro": [
                "Prăjește feliile de pâine până sunt aurii.",
                "Unge generos fiecare felie cu zacuscă.",
                "Garnisește cu pătrunjel proaspăt și servește.",
            ],
        },
    },
    {
        "id": "intl-chicken-quinoa-bowl",
        "icon": "bowl",
        "tagline": {
            "en": "A clean, colorful bowl built for meal-prep — protein, grains and greens in one container.",
            "ro": "Un bol curat și colorat, perfect pentru meal-prep — proteine, cereale și verdețuri într-un singur recipient.",
        },
        "name": {"en": "Grilled chicken, quinoa & broccoli bowl", "ro": "Bol cu pui la grătar, quinoa și broccoli"},
        "tags": ["high-protein", "quick", "meal-prep", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/%22Pilaf%22%20of%20brown%20rice%2C%20quinoa%2C%20and%20vegetables%2C%20grilled%20chicken%20thigh%20meat%2C%20and%20saut%C3%A9ed%20broccoli%20sprouts%20%E9%95%B7%E7%B2%92%E7%8E%84%E7%B1%B3%E3%81%A8%E3%82%AD%E3%83%8C%E3%82%A2%E3%81%AE%E3%83%94%E3%83%A9%E3%83%95%E3%82%82%E3%81%A9%E3%81%8D%E3%80%81%E9%B6%8F%E3%83%A2%E3%83%A2%E3%81%AE%E3%82%B0%E3%83%AA%E3%83%AB%E3%80%81%E8%8A%BD%E3%82%AD%E3%83%A3%E3%83%99%E3%83%84%E3%81%AE%E3%82%BD%E3%83%86%E3%83%BC.jpg",
        "prep_minutes": 25,
        "servings": 2,
        "weight_g": 400,
        "calories": 420,
        "protein": 38,
        "carbs": 38,
        "fats": 12,
        "fiber": 6,
        "ingredients": {
            "en": [
                "300g chicken breast",
                "150g quinoa (dry)",
                "200g broccoli florets",
                "1 tbsp olive oil",
                "1 tsp paprika, garlic powder, salt",
            ],
            "ro": [
                "300g piept de pui",
                "150g quinoa (uscată)",
                "200g broccoli, buchețele",
                "1 lingură ulei de măsline",
                "1 linguriță boia, praf de usturoi, sare",
            ],
        },
        "instructions": {
            "en": [
                "Season chicken with spices; grill or pan-sear 6-7 minutes per side until cooked through.",
                "Cook quinoa per package instructions.",
                "Steam broccoli 4-5 minutes until just tender.",
                "Slice chicken and combine everything in a bowl; drizzle with olive oil.",
            ],
            "ro": [
                "Condimentează puiul; frige pe grătar sau în tigaie 6-7 minute pe fiecare parte până e pătruns.",
                "Fierbe quinoa conform instrucțiunilor de pe ambalaj.",
                "Fierbe broccoli la abur 4-5 minute până e fraged.",
                "Feliază puiul și combină totul într-un bol; stropește cu ulei de măsline.",
            ],
        },
    },
    {
        "id": "intl-greek-yogurt-parfait",
        "icon": "parfait",
        "tagline": {
            "en": "Layers of creamy Greek yogurt, fruit and crunch — dessert-level satisfaction, protein-shake macros.",
            "ro": "Straturi de iaurt grecesc cremos, fructe și crocant — satisfacție de desert, macronutrienți de shake proteic.",
        },
        "name": {"en": "Greek yogurt & berry parfait", "ro": "Parfait cu iaurt grecesc și fructe de pădure"},
        "tags": ["high-protein", "quick", "breakfast", "vegetarian", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Yogurt%20parfait%20with%20granola%20and%20blueberries%20in%20shot%20glasses%20with%20silverware%20spoons%20(17098581522).jpg",
        "prep_minutes": 5,
        "servings": 1,
        "weight_g": 375,
        "calories": 290,
        "protein": 24,
        "carbs": 32,
        "fats": 7,
        "fiber": 5,
        "ingredients": {
            "en": ["250g plain Greek yogurt", "100g mixed berries", "25g granola", "1 tsp honey (optional)"],
            "ro": ["250g iaurt grecesc simplu", "100g fructe de pădure, mix", "25g granola", "1 linguriță miere (opțional)"],
        },
        "instructions": {
            "en": ["Layer yogurt, berries, and granola in a glass.", "Drizzle with honey if using."],
            "ro": ["Așază în straturi iaurtul, fructele de pădure și granola într-un pahar.", "Stropește cu miere, dacă folosești."],
        },
    },
    {
        "id": "intl-overnight-oats-pb",
        "icon": "oats",
        "name": {
            "en": "Dark chocolate peanut butter protein overnight oats",
            "ro": "Ovăz peste noapte cu ciocolată neagră, unt de arahide și proteină",
        },
        "tagline": {
            "en": "Tastes like dessert, preps in five minutes, waiting for you at breakfast.",
            "ro": "Are gust de desert, se pregătește în cinci minute și te așteaptă gata la micul dejun.",
        },
        "tags": ["quick", "breakfast", "vegetarian", "meal-prep", "bulk", "high-protein"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Protein%20overnight%20oats.jpg",
        "prep_minutes": 5,
        "servings": 1,
        "weight_g": 320,
        "calories": 480,
        "protein": 32,
        "carbs": 58,
        "fats": 16,
        "fiber": 9,
        "ingredients": {
            "en": [
                "60g rolled oats",
                "1 scoop (30g) chocolate whey protein powder",
                "180ml milk of choice",
                "1 tbsp peanut butter",
                "1 tbsp cacao powder",
                "1 banana, sliced",
                "1 tsp dark chocolate chips",
            ],
            "ro": [
                "60g fulgi de ovăz",
                "1 doză (30g) proteină whey cu ciocolată",
                "180ml lapte, la alegere",
                "1 lingură unt de arahide",
                "1 lingură pudră de cacao",
                "1 banană, feliată",
                "1 linguriță fulgi de ciocolată neagră",
            ],
        },
        "instructions": {
            "en": [
                "Whisk the protein powder and cacao into the milk until smooth, then stir in the oats.",
                "Swirl in the peanut butter, cover, and refrigerate overnight.",
                "Top with sliced banana and dark chocolate chips before eating.",
            ],
            "ro": [
                "Amestecă pudra proteică și cacaua în lapte până se omogenizează, apoi adaugă fulgii de ovăz.",
                "Adaugă untul de arahide prin răsucire, acoperă și lasă la frigider peste noapte.",
                "Adaugă banana feliată și fulgii de ciocolată neagră deasupra înainte de a servi.",
            ],
        },
    },
    {
        "id": "intl-salmon-sweet-potato",
        "icon": "fish",
        "tagline": {
            "en": "Omega-3-rich salmon and roasted sweet potato — simple ingredients, restaurant-level plating.",
            "ro": "Somon bogat în omega-3 și cartof dulce copt — ingrediente simple, prezentare de restaurant.",
        },
        "name": {"en": "Baked salmon, sweet potato & asparagus", "ro": "Somon la cuptor cu cartof dulce și sparanghel"},
        "tags": ["high-protein", "balanced", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Grilled%20Salmon%20(14745629127).jpg",
        "prep_minutes": 30,
        "servings": 2,
        "weight_g": 450,
        "calories": 480,
        "protein": 34,
        "carbs": 34,
        "fats": 21,
        "fiber": 6,
        "ingredients": {
            "en": [
                "300g salmon fillet",
                "2 medium sweet potatoes, cubed",
                "200g asparagus, trimmed",
                "1 tbsp olive oil",
                "1 lemon",
                "Salt, pepper, dill",
            ],
            "ro": [
                "300g file de somon",
                "2 cartofi dulci medii, tăiați cubulețe",
                "200g sparanghel, curățat",
                "1 lingură ulei de măsline",
                "1 lămâie",
                "Sare, piper, mărar",
            ],
        },
        "instructions": {
            "en": [
                "Toss sweet potato cubes in oil, roast at 200°C for 20 minutes.",
                "Add salmon and asparagus to the tray, season, and roast a further 12-15 minutes.",
                "Finish with a squeeze of lemon and fresh dill.",
            ],
            "ro": [
                "Amestecă cuburile de cartof dulce cu ulei, coace la 200°C timp de 20 de minute.",
                "Adaugă somonul și sparanghelul pe tavă, condimentează și mai coace 12-15 minute.",
                "Finalizează cu zeamă de lămâie și mărar proaspăt.",
            ],
        },
    },
    {
        "id": "intl-turkey-stirfry",
        "icon": "stirfry",
        "tagline": {
            "en": "A fast, colorful wok toss that turns lean turkey into a genuinely craveable dinner.",
            "ro": "Un salt rapid și colorat la wok, care transformă curcanul slab într-o cină cu adevărat poftibilă.",
        },
        "name": {"en": "Turkey & vegetable stir-fry", "ro": "Stir-fry cu curcan și legume"},
        "tags": ["high-protein", "quick", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Asian%20Turkey,%20Vegetables%20%26%20Rice%20(4666208892).jpg",
        "prep_minutes": 20,
        "servings": 2,
        "weight_g": 350,
        "calories": 350,
        "protein": 36,
        "carbs": 22,
        "fats": 12,
        "fiber": 5,
        "ingredients": {
            "en": [
                "300g turkey breast, sliced thin",
                "1 bell pepper, sliced",
                "1 broccoli head, cut into florets",
                "1 carrot, julienned",
                "2 tbsp soy sauce",
                "1 tbsp sesame oil",
                "1 clove garlic, 1 tsp ginger, minced",
            ],
            "ro": [
                "300g piept de curcan, feliat subțire",
                "1 ardei gras, feliat",
                "1 broccoli, tăiat în buchețele",
                "1 morcov, julien",
                "2 linguri sos de soia",
                "1 lingură ulei de susan",
                "1 cățel de usturoi, 1 linguriță ghimbir, tocate",
            ],
        },
        "instructions": {
            "en": [
                "Stir-fry turkey in sesame oil over high heat until browned, 4-5 minutes; set aside.",
                "Stir-fry vegetables, garlic, and ginger 4-5 minutes until crisp-tender.",
                "Return turkey to the pan, add soy sauce, toss to combine, and serve.",
            ],
            "ro": [
                "Călește curcanul în ulei de susan la foc iute până se rumenește, 4-5 minute; dă-l deoparte.",
                "Călește legumele, usturoiul și ghimbirul 4-5 minute până sunt crocante-fragede.",
                "Adaugă curcanul înapoi în tigaie, pune sosul de soia, amestecă și servește.",
            ],
        },
    },
    {
        "id": "intl-lentil-curry",
        "icon": "curry",
        "tagline": {
            "en": "A rich, warmly spiced curry that proves plant-based can still hit serious fiber and protein numbers.",
            "ro": "Un curry bogat și aromat, care demonstrează că o masă vegetală poate avea cifre serioase de fibre și proteine.",
        },
        "name": {"en": "Lentil & vegetable curry", "ro": "Curry cu linte și legume"},
        "tags": ["vegetarian", "high-fiber", "meal-prep", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Tadka%20Daal%20(Indian%20lentil%20curry).jpg",
        "prep_minutes": 35,
        "servings": 4,
        "weight_g": 350,
        "calories": 280,
        "protein": 15,
        "carbs": 40,
        "fats": 7,
        "fiber": 12,
        "ingredients": {
            "en": [
                "300g red lentils (dry)",
                "1 onion, diced",
                "2 cloves garlic, 1 tbsp ginger, minced",
                "400ml coconut milk",
                "400g canned tomatoes",
                "2 tsp curry powder, 1 tsp cumin, 1 tsp turmeric",
                "200g spinach",
            ],
            "ro": [
                "300g linte roșie (uscată)",
                "1 ceapă, tăiată cubulețe",
                "2 căței de usturoi, 1 lingură ghimbir, tocate",
                "400ml lapte de cocos",
                "400g roșii din conservă",
                "2 lingurițe pudră de curry, 1 linguriță chimen, 1 linguriță turmeric",
                "200g spanac",
            ],
        },
        "instructions": {
            "en": [
                "Sauté onion, garlic, and ginger until soft; add spices and toast briefly.",
                "Add lentils, tomatoes, and coconut milk; simmer 20-25 minutes until lentils are tender.",
                "Stir in spinach until wilted; season to taste.",
            ],
            "ro": [
                "Călește ceapa, usturoiul și ghimbirul până se înmoaie; adaugă mirodeniile și prăjește puțin.",
                "Adaugă lintea, roșiile și laptele de cocos; lasă la fiert 20-25 de minute până lintea e fragedă.",
                "Adaugă spanacul și lasă să se ofilească; condimentează după gust.",
            ],
        },
    },
    {
        "id": "intl-egg-white-omelette",
        "icon": "omelette",
        "name": {
            "en": "Truffle parmesan egg white scramble",
            "ro": "Ouă jumări din albuș cu trufe și parmezan",
        },
        "tagline": {
            "en": "A few drops of truffle oil turn plain egg whites into a genuinely exciting breakfast.",
            "ro": "Câteva picături de ulei de trufe transformă albușurile simple într-un mic dejun cu adevărat interesant.",
        },
        "tags": ["high-protein", "quick", "vegetarian", "breakfast", "low-calorie", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Five%20egg%20white%20fluffy%20omlette.jpg",
        "prep_minutes": 10,
        "servings": 1,
        "weight_g": 260,
        "calories": 250,
        "protein": 28,
        "carbs": 6,
        "fats": 13,
        "fiber": 2,
        "ingredients": {
            "en": [
                "6 egg whites (or 200ml liquid egg whites)",
                "50g spinach",
                "80g cherry tomatoes, halved",
                "15g parmesan, grated",
                "1/2 tsp truffle oil",
                "Salt, pepper",
            ],
            "ro": [
                "6 albușuri de ou (sau 200ml albuș lichid)",
                "50g spanac",
                "80g roșii cherry, tăiate în jumătate",
                "15g parmezan, ras",
                "1/2 linguriță ulei de trufe",
                "Sare, piper",
            ],
        },
        "instructions": {
            "en": [
                "Wilt the spinach and cherry tomatoes briefly in a non-stick pan; set aside.",
                "Pour in the egg whites and scramble gently over medium-low heat until just set.",
                "Fold the spinach, tomatoes and half the parmesan through, then plate.",
                "Finish with the remaining parmesan and a drizzle of truffle oil just before serving.",
            ],
            "ro": [
                "Ofilește rapid spanacul și roșiile cherry într-o tigaie antiaderentă; dă-le deoparte.",
                "Toarnă albușurile și amestecă ușor la foc mediu-mic până se leagă.",
                "Încorporează spanacul, roșiile și jumătate din parmezan, apoi pune pe farfurie.",
                "Finalizează cu restul de parmezan și un strop de ulei de trufe chiar înainte de servire.",
            ],
        },
    },
    {
        "id": "intl-shrimp-avocado-salad",
        "icon": "salad",
        "tagline": {
            "en": "Plump shrimp and creamy avocado over crisp greens — lean protein that still feels indulgent.",
            "ro": "Creveți suculenți și avocado cremos peste verdețuri crocante — proteine slabe care par totuși un răsfăț.",
        },
        "name": {"en": "Shrimp & avocado salad", "ro": "Salată cu creveți și avocado"},
        "tags": ["high-protein", "quick", "low-calorie", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Shrimp%20and%20Avocado%20Salad%20(13329194373).jpg",
        "prep_minutes": 15,
        "servings": 2,
        "weight_g": 320,
        "calories": 310,
        "protein": 26,
        "carbs": 14,
        "fats": 18,
        "fiber": 7,
        "ingredients": {
            "en": [
                "250g cooked shrimp, peeled",
                "1 avocado, diced",
                "100g cherry tomatoes, halved",
                "60g mixed greens",
                "1 tbsp olive oil",
                "Juice of 1 lime",
                "Salt, pepper, chili flakes (optional)",
            ],
            "ro": [
                "250g creveți gătiți, curățați",
                "1 avocado, tăiat cubulețe",
                "100g roșii cherry, tăiate în jumătate",
                "60g salată mix de frunze",
                "1 lingură ulei de măsline",
                "Zeamă de la 1 lime",
                "Sare, piper, fulgi de chili (opțional)",
            ],
        },
        "instructions": {
            "en": [
                "Toss greens, tomatoes, and avocado in a bowl.",
                "Add shrimp on top.",
                "Whisk olive oil, lime juice, salt and pepper; drizzle over and toss gently.",
            ],
            "ro": [
                "Amestecă frunzele, roșiile și avocado într-un bol.",
                "Adaugă creveții deasupra.",
                "Bate uleiul de măsline cu zeama de lime, sare și piper; toarnă peste salată și amestecă ușor.",
            ],
        },
    },
    {
        "id": "intl-steak-fajita-bowl",
        "icon": "bowl",
        "tagline": {
            "en": "Sizzling steak strips, peppers and onions — all the fajita flavor, none of the tortilla carbs.",
            "ro": "Fâșii de vită la tigaie încinsă, ardei și ceapă — toată savoarea de fajita, fără carbohidrații din tortilla.",
        },
        "name": {"en": "Steak fajita bowl", "ro": "Bol fajita cu vită"},
        "tags": ["high-protein", "quick", "meal-prep", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Beef%20Fajitas%20Costa%20Rica.JPG",
        "prep_minutes": 25,
        "servings": 2,
        "weight_g": 420,
        "calories": 460,
        "protein": 37,
        "carbs": 40,
        "fats": 16,
        "fiber": 6,
        "ingredients": {
            "en": [
                "300g beef sirloin, sliced thin",
                "1 bell pepper, sliced",
                "1 onion, sliced",
                "150g cooked rice",
                "1 tsp cumin, 1 tsp paprika, 1/2 tsp chili powder",
                "1 tbsp olive oil",
                "1 lime",
                "Fresh cilantro, chopped",
            ],
            "ro": [
                "300g mușchi de vită, feliat subțire",
                "1 ardei gras, feliat",
                "1 ceapă, feliată",
                "150g orez fiert",
                "1 linguriță chimen, 1 linguriță boia, 1/2 linguriță chili",
                "1 lingură ulei de măsline",
                "1 lime",
                "Coriandru proaspăt, tocat",
            ],
        },
        "instructions": {
            "en": [
                "Season beef with spices; sear in a hot pan 2-3 minutes per side, then rest and slice.",
                "Sauté pepper and onion in the same pan until charred at the edges.",
                "Build bowls with rice, peppers, onion, and beef.",
                "Finish with a squeeze of lime and fresh cilantro.",
            ],
            "ro": [
                "Condimentează vita cu mirodeniile; prăjește într-o tigaie încinsă 2-3 minute pe fiecare parte, apoi lasă la odihnă și feliază.",
                "Călește ardeiul și ceapa în aceeași tigaie până se rumenesc ușor pe margini.",
                "Asamblează bolurile cu orez, ardei, ceapă și vită.",
                "Finalizează cu zeamă de lime și coriandru proaspăt.",
            ],
        },
    },
    {
        "id": "intl-margherita-flatbread",
        "icon": "pizza",
        "tagline": {
            "en": "A thin, crisp flatbread kept simple — proof that a bulk-day meal can still be elegant.",
            "ro": "O flatbread subțire și crocantă, cu topping simplu — dovada că o masă de zi de masă musculară poate fi totuși elegantă.",
        },
        "name": {"en": "Margherita flatbread", "ro": "Lipie Margherita"},
        "tags": ["vegetarian", "quick", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Pizza%20Margherita%20().JPG",
        "prep_minutes": 20,
        "servings": 2,
        "weight_g": 220,
        "calories": 380,
        "protein": 16,
        "carbs": 46,
        "fats": 14,
        "fiber": 3,
        "ingredients": {
            "en": ["2 flatbreads or thin pizza bases", "100g tomato sauce", "150g fresh mozzarella, sliced", "Fresh basil leaves", "1 tbsp olive oil"],
            "ro": ["2 lipii sau blaturi subțiri de pizza", "100g sos de roșii", "150g mozzarella proaspătă, feliată", "Frunze de busuioc proaspăt", "1 lingură ulei de măsline"],
        },
        "instructions": {
            "en": [
                "Spread tomato sauce over the flatbreads.",
                "Top with mozzarella slices.",
                "Bake at 220°C for 8-10 minutes until the cheese is bubbling.",
                "Finish with fresh basil and a drizzle of olive oil.",
            ],
            "ro": [
                "Întinde sosul de roșii pe lipii.",
                "Adaugă feliile de mozzarella deasupra.",
                "Coace la 220°C timp de 8-10 minute până brânza clocotește.",
                "Finalizează cu busuioc proaspăt și un strop de ulei de măsline.",
            ],
        },
    },
    {
        "id": "intl-protein-smoothie-bowl",
        "icon": "smoothie",
        "name": {"en": "Golden turmeric protein smoothie bowl", "ro": "Bol smoothie proteic auriu cu turmeric"},
        "tagline": {
            "en": "A vivid, sunshine-colored bowl that makes hitting your protein goal feel like a treat, not a task.",
            "ro": "Un bol viu, colorat, care face atingerea țintei de proteine să pară un răsfăț, nu o corvoadă.",
        },
        "tags": ["quick", "breakfast", "vegetarian", "high-protein", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Mango%20Pineapple%20Smoothie%20Bowl.jpg",
        "prep_minutes": 8,
        "servings": 1,
        "weight_g": 380,
        "calories": 380,
        "protein": 30,
        "carbs": 48,
        "fats": 9,
        "fiber": 9,
        "ingredients": {
            "en": [
                "1 scoop (30g) vanilla protein powder",
                "1 frozen banana",
                "100g frozen mango",
                "1/2 tsp ground turmeric",
                "Pinch of black pepper (helps turmeric absorption)",
                "150ml coconut milk",
                "Toppings: granola, toasted coconut flakes, fresh berries, chia seeds",
            ],
            "ro": [
                "1 doză (30g) pudră proteică cu vanilie",
                "1 banană congelată",
                "100g mango congelat",
                "1/2 linguriță turmeric măcinat",
                "Un praf de piper negru (ajută absorbția turmericului)",
                "150ml lapte de cocos",
                "Topping: granola, fulgi de cocos prăjiți, fructe de pădure proaspete, semințe de chia",
            ],
        },
        "instructions": {
            "en": [
                "Blend protein powder, banana, mango, turmeric, black pepper, and coconut milk until thick and smooth.",
                "Pour into a bowl.",
                "Arrange granola, toasted coconut, fresh berries, and chia seeds on top in neat rows.",
            ],
            "ro": [
                "Blenduiește pudra proteică, banana, mango, turmericul, piperul și laptele de cocos până devine gros și cremos.",
                "Toarnă în bol.",
                "Aranjează granola, cocosul prăjit, fructele de pădure și semințele de chia deasupra, în rânduri ordonate.",
            ],
        },
    },
    {
        "id": "intl-tuna-pasta-salad",
        "icon": "pasta",
        "tagline": {
            "en": "A cold, make-ahead pasta salad that turns pantry tuna into a genuinely good meal-prep lunch.",
            "ro": "O salată rece de paste, pregătită din timp, care transformă tonul din cămară într-un prânz de meal-prep cu adevărat bun.",
        },
        "name": {"en": "Tuna pasta salad", "ro": "Salată de paste cu ton"},
        "tags": ["high-protein", "meal-prep", "quick", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Pan%20seared%20tuna,%20pasta%20salad.jpg",
        "prep_minutes": 20,
        "servings": 3,
        "weight_g": 300,
        "calories": 380,
        "protein": 26,
        "carbs": 46,
        "fats": 10,
        "fiber": 4,
        "ingredients": {
            "en": [
                "250g whole-wheat pasta (dry)",
                "2 cans tuna in water, drained",
                "100g cherry tomatoes, halved",
                "80g cucumber, diced",
                "50g black olives, sliced",
                "2 tbsp olive oil",
                "Juice of 1 lemon",
                "Fresh parsley",
            ],
            "ro": [
                "250g paste integrale (uscate)",
                "2 cutii ton în apă, scurs",
                "100g roșii cherry, tăiate în jumătate",
                "80g castravete, tăiat cubulețe",
                "50g măsline negre, feliate",
                "2 linguri ulei de măsline",
                "Zeamă de la 1 lămâie",
                "Pătrunjel proaspăt",
            ],
        },
        "instructions": {
            "en": [
                "Cook pasta per package instructions; drain and cool slightly.",
                "Combine pasta, tuna, tomatoes, cucumber, and olives in a large bowl.",
                "Dress with olive oil and lemon juice; toss and top with fresh parsley.",
            ],
            "ro": [
                "Fierbe pastele conform instrucțiunilor de pe ambalaj; scurge și lasă să se răcorească puțin.",
                "Combină pastele, tonul, roșiile, castravetele și măslinele într-un bol mare.",
                "Asezonează cu ulei de măsline și zeamă de lămâie; amestecă și adaugă pătrunjel proaspăt deasupra.",
            ],
        },
    },
    {
        "id": "gym-beef-rice-power-bowl",
        "icon": "bowl",
        "name": {
            "en": "Sesame-ginger beef & broccoli rice bowl",
            "ro": "Bol cu vită, broccoli și orez, cu susan și ghimbir"
        },
        "tagline": {
            "en": "Savory, glossy, takeout-style beef and broccoli — built to actually hit your bulk numbers.",
            "ro": "Vită și broccoli lucioase, cu gust de mâncare la pachet — construite să îți atingă cu adevărat cifrele de masă musculară."
        },
        "tags": [
            "high-protein",
            "meal-prep",
            "bulk"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Beef%20and%20Broccoli%20over%20rice%20-yummy%20-cookingday%20-cookingistherapy%20-beefandbroccoli%20-foodbloggers%20-cookingblog%20thank%20you%20%40dianabrowne2%20for%20the%20recipe.jpg?width=480",
        "prep_minutes": 25,
        "servings": 1,
        "weight_g": 450,
        "calories": 520,
        "protein": 38,
        "carbs": 45,
        "fats": 20,
        "fiber": 4,
        "ingredients": {
            "en": [
                "200g lean ground beef (90/10)",
                "150g cooked white rice",
                "150g broccoli florets",
                "1 tbsp soy sauce",
                "1 tsp sesame oil",
                "1 clove garlic, minced",
                "Sesame seeds, to finish"
            ],
            "ro": [
                "200g carne tocată de vită (90/10)",
                "150g orez alb fiert",
                "150g broccoli, buchețele",
                "1 lingură sos de soia",
                "1 linguriță ulei de susan",
                "1 cățel de usturoi, tocat",
                "Semințe de susan, pentru finisare"
            ]
        },
        "instructions": {
            "en": [
                "Steam or blanch the broccoli until just tender, about 4 minutes.",
                "Brown the ground beef with garlic in a hot pan, breaking it up as it cooks.",
                "Stir in soy sauce and sesame oil, then combine with the cooked rice and broccoli.",
                "Finish with a sprinkle of sesame seeds before serving."
            ],
            "ro": [
                "Fierbe broccoli la abur sau blanșează-l până e fraged, aproximativ 4 minute.",
                "Rumenește carnea tocată cu usturoiul într-o tigaie încinsă, mărunțind-o pe măsură ce se gătește.",
                "Adaugă sosul de soia și uleiul de susan, apoi combină cu orezul fiert și broccoli.",
                "Finalizează cu semințe de susan presărate deasupra înainte de servire."
            ]
        }
    },
    {
        "id": "gym-cottage-cheese-berries",
        "icon": "parfait",
        "name": {
            "en": "Cottage cheese berry parfait with toasted almonds",
            "ro": "Parfait cu brânză de vaci, fructe de pădure și migdale prăjite"
        },
        "tagline": {
            "en": "A five-minute, protein-dense parfait that tastes like dessert and logs like a clean snack.",
            "ro": "Un parfait proteic gata în cinci minute, cu gust de desert și profil de gustare curată."
        },
        "tags": [
            "high-protein",
            "quick",
            "breakfast",
            "vegetarian",
            "cut"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/10.%20cottage%20cheese%20with%20blackberries%20%26%20cashews%20%286902905454%29.jpg?width=480",
        "prep_minutes": 5,
        "servings": 1,
        "weight_g": 250,
        "calories": 230,
        "protein": 24,
        "carbs": 20,
        "fats": 6,
        "fiber": 3,
        "ingredients": {
            "en": [
                "200g low-fat cottage cheese",
                "80g mixed berries (strawberries, blueberries)",
                "1 tsp honey",
                "1 tbsp sliced almonds, toasted"
            ],
            "ro": [
                "200g brânză de vaci slabă",
                "80g fructe de pădure amestecate (căpșuni, afine)",
                "1 linguriță miere",
                "1 lingură migdale feliate, prăjite"
            ]
        },
        "instructions": {
            "en": [
                "Toast the almonds in a dry pan for 1-2 minutes until fragrant.",
                "Spoon the cottage cheese into a bowl and top with the berries and toasted almonds.",
                "Drizzle with honey just before eating."
            ],
            "ro": [
                "Prăjește migdalele într-o tigaie uscată 1-2 minute până devin aromate.",
                "Pune brânza de vaci într-un bol și adaugă deasupra fructele de pădure și migdalele prăjite.",
                "Stropește cu miere chiar înainte de a mânca."
            ]
        }
    },
    {
        "id": "gym-chicken-sweet-potato-tray",
        "icon": "bowl",
        "name": {
            "en": "Honey-garlic chicken & charred sweet potato tray",
            "ro": "Tavă cu pui glazurat cu miere și usturoi și cartof dulce caramelizat"
        },
        "tagline": {
            "en": "One tray, one clean-up — juicy chicken and caramelized sweet potato built for the whole week.",
            "ro": "O singură tavă, curățenie minimă — pui suculent și cartof dulce caramelizat, pregătite pentru toată săptămâna."
        },
        "tags": [
            "high-protein",
            "meal-prep",
            "bulk"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Halal%20Roast%20Chicken%20Leg%20%2B%20Roasted%20Sweet%20Potato%20-%20Foodilic%202024-03-25.jpg",
        "prep_minutes": 40,
        "servings": 1,
        "weight_g": 400,
        "calories": 460,
        "protein": 42,
        "carbs": 38,
        "fats": 14,
        "fiber": 6,
        "ingredients": {
            "en": [
                "200g chicken breast, cubed",
                "180g sweet potato, cubed",
                "120g green beans",
                "1 tbsp olive oil",
                "1 tbsp honey",
                "1 clove garlic, minced",
                "1 tsp paprika",
                "Salt and pepper, to taste"
            ],
            "ro": [
                "200g piept de pui, cubulețe",
                "180g cartof dulce, cubulețe",
                "120g fasole verde",
                "1 lingură ulei de măsline",
                "1 lingură miere",
                "1 cățel de usturoi, tocat",
                "1 linguriță boia dulce",
                "Sare și piper, după gust"
            ]
        },
        "instructions": {
            "en": [
                "Preheat oven to 200°C (400°F). Whisk together the honey, garlic, olive oil, and paprika.",
                "Toss the chicken, sweet potato, and green beans in the honey-garlic mixture on a tray.",
                "Roast for 25-30 minutes, turning halfway, until the chicken is charred at the edges and the sweet potato is caramelized.",
                "Divide into containers for easy meal-prep through the week."
            ],
            "ro": [
                "Preîncălzește cuptorul la 200°C. Amestecă mierea, usturoiul, uleiul de măsline și boiaua.",
                "Amestecă puiul, cartoful dulce și fasolea verde cu glazura de miere și usturoi, pe o tavă.",
                "Coace 25-30 minute, întorcând la jumătatea timpului, până puiul e ușor rumenit pe margini și cartoful e caramelizat.",
                "Împarte în cutii pentru meal-prep ușor pe parcursul săptămânii."
            ]
        }
    },
    {
        "id": "gym-baked-cod-quinoa",
        "icon": "fish",
        "name": {
            "en": "Lemon-herb baked cod with quinoa & green beans",
            "ro": "Cod la cuptor cu lămâie și ierburi, quinoa și fasole verde"
        },
        "tagline": {
            "en": "Flaky, herb-bright cod plated over quinoa — a lean dinner that still feels like a restaurant plate.",
            "ro": "Cod fraged cu ierburi aromate, servit peste quinoa — o cină slabă care pare totuși un fel de restaurant."
        },
        "tags": [
            "high-protein",
            "low-calorie",
            "cut"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Baked%20cod%20fillet.jpg",
        "prep_minutes": 30,
        "servings": 1,
        "weight_g": 380,
        "calories": 380,
        "protein": 34,
        "carbs": 32,
        "fats": 10,
        "fiber": 5,
        "ingredients": {
            "en": [
                "200g cod fillet",
                "100g quinoa (dry weight, cooked)",
                "120g green beans",
                "1 tbsp olive oil",
                "Juice of 1/2 lemon",
                "Salt and pepper, to taste"
            ],
            "ro": [
                "200g file de cod",
                "100g quinoa (greutate uscată, fiartă)",
                "120g fasole verde",
                "1 lingură ulei de măsline",
                "Zeamă de la 1/2 lămâie",
                "Sare și piper, după gust"
            ]
        },
        "instructions": {
            "en": [
                "Preheat oven to 200°C (400°F). Season the cod with salt, pepper, and lemon juice.",
                "Bake the cod for 12-15 minutes until it flakes easily.",
                "Meanwhile, cook the quinoa according to package instructions and steam the green beans.",
                "Plate the quinoa and green beans, top with the baked cod."
            ],
            "ro": [
                "Preîncălzește cuptorul la 200°C. Condimentează codul cu sare, piper și zeamă de lămâie.",
                "Coace codul 12-15 minute până se desface ușor la furculiță.",
                "Între timp, fierbe quinoa conform instrucțiunilor de pe ambalaj și fierbe fasolea verde la abur.",
                "Așază quinoa și fasolea verde pe farfurie, adaugă deasupra codul copt."
            ]
        }
    },
    {
        "id": "gym-turkey-meatball-zoodles",
        "icon": "pasta",
        "name": {
            "en": "Italian herb turkey meatballs with zucchini noodles",
            "ro": "Chiftele de curcan cu ierburi italiene și tăiței de dovlecel"
        },
        "tagline": {
            "en": "All the comfort of spaghetti and meatballs, a fraction of the carbs.",
            "ro": "Tot confortul spaghetelor cu chiftele, la o fracțiune din carbohidrați."
        },
        "tags": [
            "high-protein",
            "low-calorie",
            "cut"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Zucchini%20noodles%20%28zoodles%29%20with%20chicken%20Italian%20sausage%20and%20spaghetti%20sauce.%20On%20the%20side%20is%20chicken%20sopas%20%28Filipino%20chicken%20noodle%20soup%29%20-keroscookingadventures.jpg?width=480",
        "prep_minutes": 30,
        "servings": 1,
        "weight_g": 380,
        "calories": 340,
        "protein": 32,
        "carbs": 16,
        "fats": 16,
        "fiber": 4,
        "ingredients": {
            "en": [
                "200g ground turkey",
                "1 egg",
                "2 tbsp breadcrumbs",
                "2 medium zucchini, spiralized",
                "150ml marinara sauce",
                "1 clove garlic, minced"
            ],
            "ro": [
                "200g carne tocată de curcan",
                "1 ou",
                "2 linguri pesmet",
                "2 dovlecei medii, tăiați tip tăiței",
                "150ml sos marinara",
                "1 cățel de usturoi, tocat"
            ]
        },
        "instructions": {
            "en": [
                "Mix ground turkey, egg, breadcrumbs, and garlic; form into small meatballs.",
                "Pan-fry the meatballs until browned and cooked through, about 10-12 minutes.",
                "Warm the marinara sauce and simmer the meatballs in it for 5 minutes.",
                "Sauté the zucchini noodles briefly and serve topped with the meatballs and sauce."
            ],
            "ro": [
                "Amestecă carnea tocată de curcan, oul, pesmetul și usturoiul; formează chiftelute mici.",
                "Prăjește chiftelele până se rumenesc și se pătrund bine, aproximativ 10-12 minute.",
                "Încălzește sosul marinara și fierbe chiftelele în el timp de 5 minute.",
                "Călește rapid tăițeii de dovlecel și servește cu chiftelele și sosul deasupra."
            ]
        }
    },
    {
        "id": "gym-protein-pancakes",
        "icon": "oats",
        "name": {
            "en": "Banana protein pancake stack with almond butter drizzle",
            "ro": "Teanc de clătite proteice cu banană și sos de unt de migdale"
        },
        "tagline": {
            "en": "A stack that looks like a cheat meal and reads like a macro-friendly breakfast.",
            "ro": "Un teanc care arată ca o masă de răsfăț și se comportă ca un mic dejun prietenos cu macronutrienții."
        },
        "tags": [
            "high-protein",
            "breakfast",
            "quick",
            "maintain"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Pancake%20stack.jpg?width=480",
        "prep_minutes": 15,
        "servings": 1,
        "weight_g": 220,
        "calories": 350,
        "protein": 28,
        "carbs": 40,
        "fats": 8,
        "fiber": 5,
        "ingredients": {
            "en": [
                "50g rolled oats, blended into flour",
                "1 scoop (30g) whey protein powder",
                "1 banana, mashed",
                "2 egg whites",
                "1/2 tsp baking powder",
                "Splash of milk, as needed"
            ],
            "ro": [
                "50g fulgi de ovăz, măcinați tip făină",
                "1 doză (30g) proteină whey pudră",
                "1 banană, zdrobită",
                "2 albușuri de ou",
                "1/2 linguriță praf de copt",
                "Puțin lapte, după nevoie"
            ]
        },
        "instructions": {
            "en": [
                "Blend the oats into a rough flour, then whisk together with all remaining ingredients into a smooth batter.",
                "Thin with a splash of milk if the batter is too thick.",
                "Cook spoonfuls on a lightly oiled non-stick pan, 2-3 minutes per side, until golden.",
                "Stack and serve with your favorite toppings."
            ],
            "ro": [
                "Macină fulgii de ovăz tip făină, apoi amestecă bine cu restul ingredientelor până obții un aluat neted.",
                "Subțiază cu puțin lapte dacă aluatul e prea gros.",
                "Coace lingurele din aluat pe o tigaie antiaderentă unsă ușor, 2-3 minute pe fiecare parte, până se rumenesc.",
                "Stivuiește și servește cu toppingurile preferate."
            ]
        }
    },
    {
        "id": "gym-protein-energy-balls",
        "icon": "dessert",
        "name": {
            "en": "Dark chocolate peanut butter protein bites",
            "ro": "Bilute proteice cu ciocolată neagră și unt de arahide"
        },
        "tagline": {
            "en": "No-bake, five-minute bites for whenever a craving hits mid-cut.",
            "ro": "Bilute fără coacere, gata în cinci minute, pentru orice poftă apărută în timpul definirii."
        },
        "tags": [
            "high-protein",
            "quick",
            "vegetarian",
            "maintain"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Gluten-free%20vegan%20balls.jpg?width=480",
        "prep_minutes": 15,
        "servings": 4,
        "weight_g": 80,
        "calories": 220,
        "protein": 12,
        "carbs": 22,
        "fats": 10,
        "fiber": 3,
        "ingredients": {
            "en": [
                "100g rolled oats",
                "2 tbsp peanut butter",
                "1 scoop (30g) whey protein powder",
                "2 tbsp honey",
                "1 tbsp dark chocolate chips",
                "1-2 tbsp water, as needed"
            ],
            "ro": [
                "100g fulgi de ovăz",
                "2 linguri unt de arahide",
                "1 doză (30g) proteină whey pudră",
                "2 linguri miere",
                "1 lingură fulgi de ciocolată neagră",
                "1-2 linguri apă, după nevoie"
            ]
        },
        "instructions": {
            "en": [
                "Mix all ingredients together in a bowl until a sticky dough forms, adding water a little at a time if needed.",
                "Roll into small balls (about 20g each).",
                "Refrigerate for at least 30 minutes to firm up before eating."
            ],
            "ro": [
                "Amestecă toate ingredientele într-un bol până se formează un aluat lipicios, adăugând apă puțin câte puțin dacă e nevoie.",
                "Formează bile mici (aproximativ 20g fiecare).",
                "Ține la frigider cel puțin 30 de minute pentru a se întări înainte de a mânca."
            ]
        }
    },
    {
        "id": "gym-whey-protein-oatmeal",
        "icon": "oats",
        "name": {
            "en": "Cinnamon banana protein oatmeal bowl",
            "ro": "Bol de terci de ovăz cu proteină, banană și scorțișoară"
        },
        "tagline": {
            "en": "A warm, spiced bowl that makes hitting your morning protein target feel effortless.",
            "ro": "Un bol cald și aromat cu scorțișoară, care face să pară floare la ureche atingerea țintei de proteine de dimineață."
        },
        "tags": [
            "high-protein",
            "breakfast",
            "meal-prep",
            "bulk"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Banana%20oatmeal.jpg?width=480",
        "prep_minutes": 10,
        "servings": 1,
        "weight_g": 400,
        "calories": 460,
        "protein": 32,
        "carbs": 55,
        "fats": 12,
        "fiber": 7,
        "ingredients": {
            "en": [
                "70g rolled oats",
                "250ml milk",
                "1 scoop (30g) whey protein powder",
                "1 banana, sliced",
                "1 tbsp peanut butter",
                "Pinch of cinnamon"
            ],
            "ro": [
                "70g fulgi de ovăz",
                "250ml lapte",
                "1 doză (30g) proteină whey pudră",
                "1 banană, feliată",
                "1 lingură unt de arahide",
                "Un praf de scorțișoară"
            ]
        },
        "instructions": {
            "en": [
                "Cook the oats in the milk over medium heat, stirring occasionally, until thickened.",
                "Remove from heat and stir in the whey protein powder until smooth.",
                "Top with banana slices, peanut butter, and a pinch of cinnamon."
            ],
            "ro": [
                "Fierbe ovăzul în lapte la foc mediu, amestecând ocazional, până se îngroașă.",
                "Ia de pe foc și amestecă proteina whey până se omogenizează.",
                "Adaugă deasupra felii de banană, unt de arahide și un praf de scorțișoară."
            ]
        }
    },
    {
        "id": "gym-mass-gainer-burrito",
        "icon": "sandwich",
        "name": {
            "en": "Loaded egg, bean & avocado breakfast burrito",
            "ro": "Burrito de mic dejun cu ouă, fasole și avocado"
        },
        "tagline": {
            "en": "A genuine mass-gainer wrapped in one hand — built for the days your appetite finally shows up.",
            "ro": "Un adevărat burrito pentru masă musculară, într-o singură mână — pentru zilele în care în sfârșit ai poftă de mâncare."
        },
        "tags": [
            "high-protein",
            "breakfast",
            "bulk"
        ],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/BREKKIE%20BURRITTO%20%28cross%20section%29%20-%20Giraffe%202025-11-01.jpg?width=480",
        "prep_minutes": 15,
        "servings": 1,
        "weight_g": 320,
        "calories": 560,
        "protein": 30,
        "carbs": 42,
        "fats": 30,
        "fiber": 8,
        "ingredients": {
            "en": [
                "3 eggs, scrambled",
                "1 large flour tortilla",
                "40g shredded cheese",
                "80g black beans",
                "1/2 avocado, sliced",
                "2 tbsp salsa"
            ],
            "ro": [
                "3 ouă, jumări",
                "1 tortilla mare din făină",
                "40g brânză rasă",
                "80g fasole neagră",
                "1/2 avocado, feliat",
                "2 linguri salsa"
            ]
        },
        "instructions": {
            "en": [
                "Scramble the eggs in a lightly oiled pan until just set.",
                "Warm the tortilla, then layer with cheese, black beans, scrambled eggs, avocado, and salsa.",
                "Roll tightly into a burrito and serve, or wrap for later."
            ],
            "ro": [
                "Fă ouăle jumări într-o tigaie unsă ușor, până se leagă.",
                "Încălzește tortilla, apoi adaugă brânza, fasolea neagră, ouăle jumări, avocado și salsa.",
                "Rulează strâns tip burrito și servește, sau împachetează pentru mai târziu."
            ]
        }
    },
    {
        "id": "gym-tuna-chickpea-salad",
        "icon": "salad",
        "name": {
            "en": "Mediterranean tuna & chickpea salad",
            "ro": "Salată mediteraneeană cu ton și năut"
        },
        "tagline": {
            "en": "A bright, lemony bowl that turns pantry staples into a genuinely craveable lunch.",
            "ro": "Un bol proaspăt și citric care transformă ingrediente de cămară într-un prânz cu adevărat poftibil."
        },
        "tags": [
            "high-protein",
            "quick",
            "low-calorie",
            "cut"
        ],
        "prep_minutes": 10,
        "servings": 1,
        "weight_g": 320,
        "calories": 350,
        "protein": 30,
        "carbs": 28,
        "fats": 12,
        "fiber": 8,
        "ingredients": {
            "en": [
                "1 can (150g) tuna in water, drained",
                "150g cooked chickpeas",
                "1/2 cucumber, diced",
                "1/4 red onion, thinly sliced",
                "1 tbsp olive oil",
                "Juice of 1/2 lemon"
            ],
            "ro": [
                "1 cutie (150g) ton în apă, scurs",
                "150g năut fiert",
                "1/2 castravete, cubulețe",
                "1/4 ceapă roșie, feliată subțire",
                "1 lingură ulei de măsline",
                "Zeamă de la 1/2 lămâie"
            ]
        },
        "instructions": {
            "en": [
                "Combine the tuna, chickpeas, cucumber, and red onion in a bowl.",
                "Dress with olive oil and lemon juice.",
                "Toss well and season with salt and pepper to taste."
            ],
            "ro": [
                "Combină tonul, năutul, castravetele și ceapa roșie într-un bol.",
                "Asezonează cu ulei de măsline și zeamă de lămâie.",
                "Amestecă bine și condimentează cu sare și piper după gust."
            ]
        }
    },
    # -------------------------------------------------------------------
    # "Signature" tier — a small set of restaurant-caliber, visually striking
    # fitness meals added to elevate the top of the catalog beyond the
    # everyday meal-prep entries above. Same realistic-estimate honesty and
    # bilingual shape as everything else in this file; each carries a
    # `tagline` (see RecipeResult.tagline in backend/models.py) written to
    # actually sell the dish, not just describe it.
    # -------------------------------------------------------------------
    {
        "id": "signature-ahi-tuna-poke-bowl",
        "icon": "bowl",
        "name": {"en": "Seared ahi tuna poke bowl", "ro": "Bol poke cu ton ahi"},
        "tagline": {
            "en": "Restaurant-grade poke, built in your own kitchen in twenty minutes.",
            "ro": "Poke de nivel restaurant, gata în propria bucătărie în douăzeci de minute.",
        },
        "tags": ["high-protein", "quick", "cut", "meal-prep"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Tuna%20poke%20at%20Cafe%20La%20Haye%20-%20Sarah%20Stierch.jpg",
        "prep_minutes": 20,
        "servings": 1,
        "weight_g": 420,
        "calories": 480,
        "protein": 38,
        "carbs": 52,
        "fats": 14,
        "fiber": 5,
        "ingredients": {
            "en": [
                "150g sushi-grade ahi tuna, cubed",
                "150g cooked sushi rice",
                "1/2 avocado, sliced",
                "50g edamame, shelled",
                "1/4 cucumber, diced",
                "1 tbsp soy sauce",
                "1 tsp sesame oil",
                "1 tsp sriracha (optional)",
                "Sesame seeds and scallions, to finish",
            ],
            "ro": [
                "150g ton ahi calitate sushi, cubulețe",
                "150g orez sushi fiert",
                "1/2 avocado, feliat",
                "50g edamame, decorticat",
                "1/4 castravete, cubulețe",
                "1 lingură sos de soia",
                "1 linguriță ulei de susan",
                "1 linguriță sriracha (opțional)",
                "Semințe de susan și ceapă verde, pentru finisare",
            ],
        },
        "instructions": {
            "en": [
                "Toss the cubed tuna with soy sauce, sesame oil and sriracha; let marinate 5 minutes.",
                "Divide the sushi rice between bowls and arrange the tuna, avocado, edamame and cucumber on top.",
                "Finish with sesame seeds and sliced scallions just before serving.",
            ],
            "ro": [
                "Amestecă tonul cubulețe cu sosul de soia, uleiul de susan și sriracha; lasă la marinat 5 minute.",
                "Împarte orezul sushi în boluri și aranjează deasupra tonul, avocado, edamame și castravetele.",
                "Finalizează cu semințe de susan și ceapă verde feliată chiar înainte de servire.",
            ],
        },
    },
    {
        "id": "signature-miso-salmon-broccolini",
        "icon": "fish",
        "name": {"en": "Miso-glazed salmon with charred broccolini", "ro": "Somon glazurat cu miso și broccolini rumenit"},
        "tagline": {
            "en": "A glossy, umami-rich glaze that turns a weeknight salmon into a plated occasion.",
            "ro": "O glazură lucioasă și bogată în umami, care transformă un somon de zi cu zi într-un fel demn de ocazii speciale.",
        },
        "tags": ["high-protein", "balanced", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Miso%20Salmon.jpg",
        "prep_minutes": 25,
        "servings": 1,
        "weight_g": 380,
        "calories": 500,
        "protein": 36,
        "carbs": 22,
        "fats": 28,
        "fiber": 4,
        "ingredients": {
            "en": [
                "200g salmon fillet",
                "1 tbsp white miso paste",
                "1 tbsp honey",
                "1 tsp rice vinegar",
                "150g broccolini",
                "1 tsp sesame oil",
                "1 tsp sesame seeds",
            ],
            "ro": [
                "200g file de somon",
                "1 lingură pastă miso albă",
                "1 lingură miere",
                "1 linguriță oțet de orez",
                "150g broccolini",
                "1 linguriță ulei de susan",
                "1 linguriță semințe de susan",
            ],
        },
        "instructions": {
            "en": [
                "Whisk together the miso, honey and rice vinegar; brush half over the salmon.",
                "Sear the salmon skin-side down in a hot pan, then finish under the broiler for 4-5 minutes, basting with the remaining glaze.",
                "Toss the broccolini with sesame oil and char it in a hot pan or under the broiler until blistered, about 5 minutes.",
                "Plate the salmon over the broccolini and sprinkle with sesame seeds.",
            ],
            "ro": [
                "Amestecă pasta miso, mierea și oțetul de orez; unge jumătate din glazură pe somon.",
                "Prăjește somonul cu pielea în jos într-o tigaie încinsă, apoi finalizează la grill/broiler 4-5 minute, ungând cu restul de glazură.",
                "Călește broccolini cu ulei de susan și rumenește-l la tigaie încinsă sau la broiler până se pârlește ușor, aproximativ 5 minute.",
                "Așază somonul peste broccolini și presară semințe de susan.",
            ],
        },
    },
    {
        "id": "signature-gochujang-beef-bowl",
        "icon": "bowl",
        "name": {"en": "Korean gochujang beef bowl", "ro": "Bol coreean cu vită și gochujang"},
        "tagline": {
            "en": "Sweet, spicy, deeply savory — a bibimbap-style bowl that makes a bulk day feel like a treat.",
            "ro": "Dulce, picant, intens de gustos — un bol stil bibimbap care face o zi de masă musculară să pară un răsfăț.",
        },
        "tags": ["high-protein", "bulk", "meal-prep"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Beef%20Bibimbap%20-%20SAERO%202025-11-06.jpg",
        "prep_minutes": 25,
        "servings": 1,
        "weight_g": 460,
        "calories": 560,
        "protein": 34,
        "carbs": 58,
        "fats": 20,
        "fiber": 4,
        "ingredients": {
            "en": [
                "200g thinly sliced beef (sirloin or ribeye)",
                "1 tbsp gochujang paste",
                "1 tbsp soy sauce",
                "1 tsp brown sugar",
                "1 clove garlic, minced",
                "180g cooked white rice",
                "1 egg, fried sunny-side up",
                "30g kimchi",
                "1/2 carrot, julienned",
            ],
            "ro": [
                "200g vită feliată subțire (antricot sau vrăbioară)",
                "1 lingură pastă gochujang",
                "1 lingură sos de soia",
                "1 linguriță zahăr brun",
                "1 cățel de usturoi, tocat",
                "180g orez alb fiert",
                "1 ou, ochi",
                "30g kimchi",
                "1/2 morcov, julienne",
            ],
        },
        "instructions": {
            "en": [
                "Marinate the beef in gochujang, soy sauce, brown sugar and garlic for at least 10 minutes.",
                "Sear the beef in a hot pan for 2-3 minutes per side until caramelized.",
                "Serve over rice with the fried egg, kimchi and julienned carrot on top.",
            ],
            "ro": [
                "Marinează vita în gochujang, sos de soia, zahăr brun și usturoi cel puțin 10 minute.",
                "Prăjește vita într-o tigaie încinsă 2-3 minute pe fiecare parte, până se caramelizează.",
                "Servește peste orez, cu oul ochi, kimchi și morcovul julienne deasupra.",
            ],
        },
    },
    {
        "id": "signature-cajun-shrimp-cauliflower-rice",
        "icon": "stirfry",
        "name": {"en": "Blackened Cajun shrimp & cauliflower rice", "ro": "Creveți Cajun rumeniți cu orez de conopidă"},
        "tagline": {
            "en": "Bold blackened spice, almost zero carbs — a cut-phase dinner that never feels like restriction.",
            "ro": "Condimente Cajun intense, aproape zero carbohidrați — o cină de definire care nu are gust de restricție.",
        },
        "tags": ["high-protein", "low-calorie", "cut", "quick"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Blackened%20Prawns.jpg",
        "prep_minutes": 20,
        "servings": 1,
        "weight_g": 380,
        "calories": 320,
        "protein": 34,
        "carbs": 18,
        "fats": 12,
        "fiber": 6,
        "ingredients": {
            "en": [
                "220g shrimp, peeled and deveined",
                "1 tbsp Cajun seasoning",
                "1 tbsp olive oil",
                "300g cauliflower rice",
                "1/2 red bell pepper, diced",
                "Juice of 1/2 lime",
                "Fresh cilantro, chopped",
            ],
            "ro": [
                "220g creveți, curățați",
                "1 lingură condiment Cajun",
                "1 lingură ulei de măsline",
                "300g orez de conopidă",
                "1/2 ardei gras roșu, cubulețe",
                "Zeamă de la 1/2 lime",
                "Coriandru proaspăt, tocat",
            ],
        },
        "instructions": {
            "en": [
                "Toss the shrimp with Cajun seasoning until well coated.",
                "Sear the shrimp in half the olive oil over high heat, 1-2 minutes per side, until blackened and cooked through; set aside.",
                "In the same pan, sauté the cauliflower rice and bell pepper in the remaining oil for 5-6 minutes.",
                "Combine with the shrimp and finish with lime juice and cilantro.",
            ],
            "ro": [
                "Amestecă creveții cu condimentul Cajun până se acoperă bine.",
                "Prăjește creveții în jumătate din uleiul de măsline, la foc mare, 1-2 minute pe fiecare parte, până se rumenesc bine și se pătrund; dă-i deoparte.",
                "În aceeași tigaie, călește orezul de conopidă și ardeiul în uleiul rămas, 5-6 minute.",
                "Combină cu creveții și finalizează cu zeamă de lime și coriandru.",
            ],
        },
    },
    {
        "id": "signature-moroccan-harissa-chicken-bowl",
        "icon": "curry",
        "name": {"en": "Moroccan harissa chicken power bowl", "ro": "Bol energizant marocan cu pui și harissa"},
        "tagline": {
            "en": "Warmly spiced, herb-bright and genuinely filling — a power bowl that doesn't taste like a spreadsheet.",
            "ro": "Aromat, proaspăt și cu adevărat sățios — un bol energizant care nu are gust de calcul de macronutrienți.",
        },
        "tags": ["high-protein", "balanced", "bulk", "meal-prep"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Chicken%20Couscous.jpg",
        "prep_minutes": 30,
        "servings": 1,
        "weight_g": 450,
        "calories": 520,
        "protein": 40,
        "carbs": 48,
        "fats": 16,
        "fiber": 8,
        "ingredients": {
            "en": [
                "200g chicken thighs, boneless",
                "1 tbsp harissa paste",
                "1 tsp olive oil",
                "120g cooked couscous",
                "100g cooked chickpeas",
                "2 tbsp plain Greek yogurt",
                "Fresh mint, chopped",
            ],
            "ro": [
                "200g pulpe de pui dezosate",
                "1 lingură pastă harissa",
                "1 linguriță ulei de măsline",
                "120g cuscus fiert",
                "100g năut fiert",
                "2 linguri iaurt grecesc simplu",
                "Mentă proaspătă, tocată",
            ],
        },
        "instructions": {
            "en": [
                "Rub the chicken with harissa and olive oil; let marinate 10 minutes if time allows.",
                "Grill or pan-sear the chicken for 6-7 minutes per side until cooked through, then slice.",
                "Serve over couscous and chickpeas, topped with a dollop of yogurt and fresh mint.",
            ],
            "ro": [
                "Unge puiul cu harissa și ulei de măsline; lasă la marinat 10 minute dacă ai timp.",
                "Frige puiul la grătar sau în tigaie 6-7 minute pe fiecare parte până se pătrunde, apoi feliază-l.",
                "Servește peste cuscus și năut, cu iaurt și mentă proaspătă deasupra.",
            ],
        },
    },
    {
        "id": "signature-sirloin-steak-chimichurri-bowl",
        "icon": "bowl",
        "name": {"en": "Iron sirloin steak bowl with chimichurri", "ro": "Bol cu mușchi de vită și sos chimichurri"},
        "tagline": {
            "en": "A steakhouse-plate bowl built for the days your bulk actually calls for it.",
            "ro": "Un bol demn de un restaurant de fripturi, pentru zilele în care masa musculară chiar o cere.",
        },
        "tags": ["high-protein", "bulk", "gym"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Skirt%20steak%20with%20chimichurri%20sauce%2C%20scrambled%20eggs%2C%20potatoes%2C%20and%20a%20salad%20-%20San%20Francisco%2C%20CA.jpg",
        "prep_minutes": 25,
        "servings": 1,
        "weight_g": 420,
        "calories": 560,
        "protein": 42,
        "carbs": 34,
        "fats": 26,
        "fiber": 5,
        "ingredients": {
            "en": [
                "220g sirloin steak",
                "2 tbsp chimichurri sauce (parsley, garlic, olive oil, red wine vinegar)",
                "180g roasted sweet potato, cubed",
                "50g mixed greens",
                "Salt and pepper, to taste",
            ],
            "ro": [
                "220g mușchi de vită (sirloin)",
                "2 linguri sos chimichurri (pătrunjel, usturoi, ulei de măsline, oțet de vin roșu)",
                "180g cartof dulce copt, cubulețe",
                "50g mix de salată verde",
                "Sare și piper, după gust",
            ],
        },
        "instructions": {
            "en": [
                "Season the steak generously and sear in a hot pan, 3-4 minutes per side for medium-rare; rest 5 minutes before slicing.",
                "Roast the sweet potato cubes at 200°C (400°F) for 20-25 minutes until caramelized.",
                "Slice the steak against the grain and plate over the sweet potato and greens, spooning chimichurri generously on top.",
            ],
            "ro": [
                "Condimentează generos vita și prăjește-o într-o tigaie încinsă, 3-4 minute pe fiecare parte pentru mediu-în sânge; lasă la odihnă 5 minute înainte de feliere.",
                "Coace cuburile de cartof dulce la 200°C timp de 20-25 minute până se caramelizează.",
                "Feliază vita perpendicular pe fibră și așaz-o peste cartoful dulce și salata verde, turnând generos chimichurri deasupra.",
            ],
        },
    },
    {
        "id": "signature-peach-mozzarella-prosciutto-salad",
        "icon": "salad",
        "name": {"en": "Charred peach, mozzarella & prosciutto salad", "ro": "Salată cu piersică rumenită, mozzarella și prosciutto"},
        "tagline": {
            "en": "Sweet charred fruit and creamy mozzarella make lean protein feel like a summer menu special.",
            "ro": "Fructul rumenit și dulce alături de mozzarella cremoasă transformă proteina slabă într-un preparat de sezon estival.",
        },
        "tags": ["high-protein", "quick", "cut", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Mozzarella%20ball%20with%20Italian%20ham%20and%20peaches%20salad%20from%20Pizza%20Express%20Hong%20Kong.jpg",
        "prep_minutes": 15,
        "servings": 1,
        "weight_g": 350,
        "calories": 400,
        "protein": 26,
        "carbs": 22,
        "fats": 22,
        "fiber": 4,
        "ingredients": {
            "en": [
                "70g prosciutto, thinly sliced",
                "1 ripe peach, halved and grilled",
                "80g fresh mozzarella",
                "60g arugula",
                "1 tbsp balsamic glaze",
                "1 tsp olive oil",
            ],
            "ro": [
                "70g prosciutto, feliat subțire",
                "1 piersică coaptă, tăiată jumătăți și rumenită",
                "80g mozzarella proaspătă",
                "60g rucola",
                "1 lingură glazură balsamică",
                "1 linguriță ulei de măsline",
            ],
        },
        "instructions": {
            "en": [
                "Grill the peach halves cut-side down for 2-3 minutes until charred and softened.",
                "Arrange arugula on a plate, top with the prosciutto, charred peach and torn mozzarella.",
                "Drizzle with olive oil and balsamic glaze just before serving.",
            ],
            "ro": [
                "Frige jumătățile de piersică cu partea tăiată în jos 2-3 minute până se rumenesc și se înmoaie.",
                "Așază rucola pe farfurie, adaugă prosciutto, piersica rumenită și mozzarella ruptă bucăți.",
                "Stropește cu ulei de măsline și glazură balsamică chiar înainte de servire.",
            ],
        },
    },
]

WORKOUT_PLANS = [
    {
        "id": "ppl-3day",
        "icon": "split",
        "name": {"en": "Push / Pull / Legs (3-day split)", "ro": "Push / Pull / Legs (împărțire pe 3 zile)"},
        "tags": ["strength", "gym", "intermediate", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Bench%20press%201.jpg",
        "level": "intermediate",
        "days": [
            {
                "label": {"en": "Push", "ro": "Push (împins)"},
                "exercises": [
                    {"name": "Bench Press", "sets": 4, "reps": "8-10"},
                    {"name": "Overhead Press", "sets": 3, "reps": "8-10"},
                    {"name": "Incline Dumbbell Press", "sets": 3, "reps": "10-12"},
                    {"name": "Triceps Pushdown", "sets": 3, "reps": "12-15"},
                    {"name": "Lateral Raise", "sets": 3, "reps": "12-15"},
                ],
            },
            {
                "label": {"en": "Pull", "ro": "Pull (tras)"},
                "exercises": [
                    {"name": "Deadlift", "sets": 3, "reps": "5-6"},
                    {"name": "Pull-Up", "sets": 4, "reps": "AMRAP"},
                    {"name": "Barbell Row", "sets": 3, "reps": "8-10"},
                    {"name": "Face Pull", "sets": 3, "reps": "15"},
                    {"name": "Barbell Curl", "sets": 3, "reps": "10-12"},
                ],
            },
            {
                "label": {"en": "Legs", "ro": "Legs (picioare)"},
                "exercises": [
                    {"name": "Squat", "sets": 4, "reps": "6-8"},
                    {"name": "Romanian Deadlift", "sets": 3, "reps": "8-10"},
                    {"name": "Leg Press", "sets": 3, "reps": "10-12"},
                    {"name": "Leg Curl", "sets": 3, "reps": "12"},
                    {"name": "Standing Calf Raise", "sets": 4, "reps": "15"},
                ],
            },
        ],
    },
    {
        "id": "full-body-3x",
        "icon": "fullbody",
        "name": {"en": "Full Body (3x/week)", "ro": "Full Body (3x/săptămână)"},
        "tags": ["strength", "gym", "beginner", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Woman%20doing%20squat%20workout%20in%20gym%20with%20barbell.jpg",
        "level": "beginner",
        "days": [
            {
                "label": {"en": "Day A", "ro": "Ziua A"},
                "exercises": [
                    {"name": "Squat", "sets": 3, "reps": "8"},
                    {"name": "Bench Press", "sets": 3, "reps": "8"},
                    {"name": "Barbell Row", "sets": 3, "reps": "8"},
                    {"name": "Plank", "sets": 3, "reps": "30-45s"},
                ],
            },
            {
                "label": {"en": "Day B", "ro": "Ziua B"},
                "exercises": [
                    {"name": "Deadlift", "sets": 3, "reps": "5"},
                    {"name": "Overhead Press", "sets": 3, "reps": "8"},
                    {"name": "Lat Pulldown", "sets": 3, "reps": "10"},
                    {"name": "Bicycle Crunch", "sets": 3, "reps": "15"},
                ],
            },
            {
                "label": {"en": "Day C", "ro": "Ziua C"},
                "exercises": [
                    {"name": "Leg Press", "sets": 3, "reps": "10"},
                    {"name": "Incline Dumbbell Press", "sets": 3, "reps": "10"},
                    {"name": "Seated Cable Row", "sets": 3, "reps": "10"},
                    {"name": "Side Plank", "sets": 3, "reps": "30s"},
                ],
            },
        ],
    },
    {
        "id": "home-bodyweight",
        "icon": "bodyweight",
        "name": {"en": "Home Bodyweight", "ro": "Antrenament acasă (greutate corporală)"},
        "tags": ["bodyweight", "home", "beginner", "no-equipment", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Doug%20Pruden%20doing%20back%20of%20the%20hand%20push%20ups%20MG%200045.JPG",
        "level": "beginner",
        "days": [
            {
                "label": {"en": "Day A", "ro": "Ziua A"},
                "exercises": [
                    {"name": "Push-Up", "sets": 3, "reps": "12-15"},
                    {"name": "Bodyweight Squat", "sets": 3, "reps": "15-20"},
                    {"name": "Plank", "sets": 3, "reps": "30-45s"},
                    {"name": "Glute Bridge", "sets": 3, "reps": "15"},
                ],
            },
            {
                "label": {"en": "Day B", "ro": "Ziua B"},
                "exercises": [
                    {"name": "Pike Push-Up", "sets": 3, "reps": "10-12"},
                    {"name": "Lunge", "sets": 3, "reps": "12 per leg"},
                    {"name": "Superman", "sets": 3, "reps": "15"},
                    {"name": "Mountain Climber", "sets": 3, "reps": "20"},
                ],
            },
            {
                "label": {"en": "Day C", "ro": "Ziua C"},
                "exercises": [
                    {"name": "Diamond Push-Up", "sets": 3, "reps": "10"},
                    {"name": "Jump Squat", "sets": 3, "reps": "12"},
                    {"name": "Bicycle Crunch", "sets": 3, "reps": "20"},
                    {"name": "Wall Sit", "sets": 3, "reps": "30-45s"},
                ],
            },
        ],
    },
    {
        "id": "upper-lower-4day",
        "icon": "upperlower",
        "name": {"en": "Upper / Lower Split (4-day)", "ro": "Upper / Lower (împărțire pe 4 zile)"},
        "tags": ["strength", "gym", "advanced", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Barbell%20row.jpg",
        "level": "advanced",
        "days": [
            {
                "label": {"en": "Upper A", "ro": "Partea superioară A"},
                "exercises": [
                    {"name": "Bench Press", "sets": 5, "reps": "5"},
                    {"name": "Barbell Row", "sets": 4, "reps": "8"},
                    {"name": "Overhead Press", "sets": 3, "reps": "8"},
                    {"name": "Pull-Up", "sets": 3, "reps": "AMRAP"},
                    {"name": "Triceps Dip", "sets": 3, "reps": "10"},
                ],
            },
            {
                "label": {"en": "Lower A", "ro": "Partea inferioară A"},
                "exercises": [
                    {"name": "Squat", "sets": 5, "reps": "5"},
                    {"name": "Romanian Deadlift", "sets": 3, "reps": "8"},
                    {"name": "Leg Press", "sets": 3, "reps": "10"},
                    {"name": "Standing Calf Raise", "sets": 4, "reps": "15"},
                ],
            },
            {
                "label": {"en": "Upper B", "ro": "Partea superioară B"},
                "exercises": [
                    {"name": "Incline Bench Press", "sets": 4, "reps": "8"},
                    {"name": "Lat Pulldown", "sets": 4, "reps": "8"},
                    {"name": "Dumbbell Shoulder Press", "sets": 3, "reps": "10"},
                    {"name": "Barbell Curl", "sets": 3, "reps": "10"},
                    {"name": "Cable Pushdown", "sets": 3, "reps": "12"},
                ],
            },
            {
                "label": {"en": "Lower B", "ro": "Partea inferioară B"},
                "exercises": [
                    {"name": "Deadlift", "sets": 4, "reps": "5"},
                    {"name": "Front Squat", "sets": 3, "reps": "8"},
                    {"name": "Leg Curl", "sets": 3, "reps": "12"},
                    {"name": "Hip Thrust", "sets": 3, "reps": "10"},
                ],
            },
        ],
    },
    {
        "id": "bro-split-5day",
        "icon": "brosplit",
        "name": {"en": "Bro Split (5-day)", "ro": "Bro Split (împărțire pe 5 zile)"},
        "tags": ["strength", "gym", "advanced", "bodybuilding", "bulk"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Girl%20doing%20double%20dumbbell%20bicep%20curl.jpg",
        "level": "advanced",
        "days": [
            {
                "label": {"en": "Chest", "ro": "Piept"},
                "exercises": [
                    {"name": "Bench Press", "sets": 4, "reps": "6-8"},
                    {"name": "Incline Dumbbell Press", "sets": 4, "reps": "8-10"},
                    {"name": "Cable Fly", "sets": 3, "reps": "12-15"},
                    {"name": "Dip", "sets": 3, "reps": "10-12"},
                ],
            },
            {
                "label": {"en": "Back", "ro": "Spate"},
                "exercises": [
                    {"name": "Deadlift", "sets": 4, "reps": "5"},
                    {"name": "Pull-Up", "sets": 4, "reps": "AMRAP"},
                    {"name": "Barbell Row", "sets": 3, "reps": "8-10"},
                    {"name": "Seated Cable Row", "sets": 3, "reps": "10-12"},
                ],
            },
            {
                "label": {"en": "Shoulders", "ro": "Umeri"},
                "exercises": [
                    {"name": "Overhead Press", "sets": 4, "reps": "6-8"},
                    {"name": "Lateral Raise", "sets": 4, "reps": "12-15"},
                    {"name": "Rear Delt Fly", "sets": 3, "reps": "12-15"},
                    {"name": "Face Pull", "sets": 3, "reps": "15"},
                ],
            },
            {
                "label": {"en": "Arms", "ro": "Brațe"},
                "exercises": [
                    {"name": "Barbell Curl", "sets": 3, "reps": "10-12"},
                    {"name": "Triceps Pushdown", "sets": 3, "reps": "10-12"},
                    {"name": "Hammer Curl", "sets": 3, "reps": "12"},
                    {"name": "Skull Crusher", "sets": 3, "reps": "10-12"},
                ],
            },
            {
                "label": {"en": "Legs", "ro": "Picioare"},
                "exercises": [
                    {"name": "Squat", "sets": 4, "reps": "6-8"},
                    {"name": "Romanian Deadlift", "sets": 3, "reps": "8-10"},
                    {"name": "Leg Press", "sets": 3, "reps": "10-12"},
                    {"name": "Standing Calf Raise", "sets": 4, "reps": "15"},
                ],
            },
        ],
    },
    {
        "id": "hiit-cardio-3day",
        "icon": "hiit",
        "name": {"en": "HIIT Conditioning (3-day)", "ro": "Antrenament HIIT (3 zile)"},
        "tags": ["cardio", "bodyweight", "home", "intermediate", "no-equipment", "cut"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Battle%20rope%20exercise%20by%20a%20young%20man%20at%20Kanu%20Sports%20centre,%20Owerri,%20Imo%20State.jpg",
        "level": "intermediate",
        "days": [
            {
                "label": {"en": "Circuit A", "ro": "Circuit A"},
                "exercises": [
                    {"name": "Jumping Jacks", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Burpee", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Mountain Climber", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "High Knees", "sets": 4, "reps": "40s on / 20s off"},
                ],
            },
            {
                "label": {"en": "Circuit B", "ro": "Circuit B"},
                "exercises": [
                    {"name": "Jump Squat", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Push-Up", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Skater Jump", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Plank Shoulder Tap", "sets": 4, "reps": "40s on / 20s off"},
                ],
            },
            {
                "label": {"en": "Circuit C", "ro": "Circuit C"},
                "exercises": [
                    {"name": "Squat Thrust", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Lunge Jump", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Bicycle Crunch", "sets": 4, "reps": "40s on / 20s off"},
                    {"name": "Sprint in Place", "sets": 4, "reps": "40s on / 20s off"},
                ],
            },
        ],
    },
    {
        "id": "home-dumbbell-3day",
        "icon": "dumbbell",
        "name": {"en": "Home Dumbbell Plan (3-day)", "ro": "Plan cu gantere acasă (3 zile)"},
        "tags": ["home", "beginner", "strength", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Fitness%20enthusiast%20lifts%20vibrant%20dumbbell%20during%20home%20workout.jpg",
        "level": "beginner",
        "days": [
            {
                "label": {"en": "Day A — Upper", "ro": "Ziua A — Partea superioară"},
                "exercises": [
                    {"name": "Dumbbell Bench Press", "sets": 3, "reps": "10-12"},
                    {"name": "Dumbbell Row", "sets": 3, "reps": "10-12"},
                    {"name": "Dumbbell Shoulder Press", "sets": 3, "reps": "10-12"},
                    {"name": "Dumbbell Curl", "sets": 3, "reps": "12"},
                ],
            },
            {
                "label": {"en": "Day B — Lower", "ro": "Ziua B — Partea inferioară"},
                "exercises": [
                    {"name": "Goblet Squat", "sets": 3, "reps": "12-15"},
                    {"name": "Dumbbell Romanian Deadlift", "sets": 3, "reps": "10-12"},
                    {"name": "Walking Lunge", "sets": 3, "reps": "12 per leg"},
                    {"name": "Standing Calf Raise", "sets": 3, "reps": "15"},
                ],
            },
            {
                "label": {"en": "Day C — Full Body", "ro": "Ziua C — Corp întreg"},
                "exercises": [
                    {"name": "Dumbbell Deadlift", "sets": 3, "reps": "10"},
                    {"name": "Dumbbell Thruster", "sets": 3, "reps": "10-12"},
                    {"name": "Renegade Row", "sets": 3, "reps": "10 per side"},
                    {"name": "Plank", "sets": 3, "reps": "30-45s"},
                ],
            },
        ],
    },
    {
        "id": "mobility-recovery",
        "icon": "mobility",
        "name": {"en": "Mobility & Recovery Day", "ro": "Zi de mobilitate și recuperare"},
        "tags": ["mobility", "home", "beginner", "no-equipment", "recovery", "maintain"],
        "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Woman%20on%20the%20yoga%20mat%20stretching%20her%20hamstrings%20-%2050398044188.jpg",
        "level": "beginner",
        "days": [
            {
                "label": {"en": "Full Routine", "ro": "Rutina completă"},
                "exercises": [
                    {"name": "Cat-Cow Stretch", "sets": 2, "reps": "10"},
                    {"name": "World's Greatest Stretch", "sets": 2, "reps": "6 per side"},
                    {"name": "Hip Flexor Stretch", "sets": 2, "reps": "30s per side"},
                    {"name": "Thoracic Spine Rotation", "sets": 2, "reps": "10 per side"},
                    {"name": "Downward Dog", "sets": 2, "reps": "30s"},
                    {"name": "Foam Rolling — Quads & Back", "sets": 1, "reps": "5 min"},
                ],
            },
        ],
    },
]

# ---------------------------------------------------------------------------
# Curated "Popular exercises" — a hand-picked, hand-verified set of common
# gym movements shown by default in the Discover exercise library (before
# the user types a search), same shape as ExerciseResult (models.py) so it
# can be returned interchangeably with a live wger.de search result. This
# exists because wger's own photos are community-submitted and uneven —
# some exercises have none at all, some are low-quality or barely related to
# the movement (see routers/discover.py's module docstring) — so the
# exercises most people actually look for get a real, checked photo instead
# of leaving that to chance. `image_url` values are Wikimedia Commons
# hotlinks, same sourcing/verification approach as RECIPES/WORKOUT_PLANS
# above. IDs start at 900001, well above wger's own real ID range, so a
# curated entry can never collide with a live wger.de exercise id.
# `license_author` is intentionally None (unlike a live wger result, which
# surfaces wger's own required CC-BY-SA attribution) — these are separate,
# directly-sourced Commons photos, not wger's community uploads.
POPULAR_EXERCISES = [
    {"id": 900001, "name": "Barbell Back Squat", "category": "Legs", "muscles": ["Quadriceps", "Glutes", "Hamstrings"], "equipment": ["Barbell", "Squat Rack"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Woman%20doing%20squat%20workout%20in%20gym%20with%20barbell%2C%20back%20view.jpg?width=480", "license_author": None},
    {"id": 900002, "name": "Deadlift", "category": "Back", "muscles": ["Hamstrings", "Glutes", "Lower Back"], "equipment": ["Barbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Deadlift%20%281%29.JPG?width=480", "license_author": None},
    {"id": 900003, "name": "Bench Press", "category": "Chest", "muscles": ["Chest", "Triceps", "Shoulders"], "equipment": ["Barbell", "Bench"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Bench%20press%201.jpg?width=480", "license_author": None},
    {"id": 900004, "name": "Overhead Press", "category": "Shoulders", "muscles": ["Shoulders", "Triceps"], "equipment": ["Barbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Attractive%20sporty%20woman%20doing%20overhead%20press%20in%20gym%20with%20barbell.jpg?width=480", "license_author": None},
    {"id": 900005, "name": "Barbell Row", "category": "Back", "muscles": ["Upper Back", "Lats", "Biceps"], "equipment": ["Barbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Barbell%20row.jpg?width=480", "license_author": None},
    {"id": 900006, "name": "Pull-Up", "category": "Back", "muscles": ["Lats", "Biceps"], "equipment": ["Pull-up Bar"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Pull-ups%20exercise%20from%20back.jpg?width=480", "license_author": None},
    {"id": 900007, "name": "Chin-Up", "category": "Back", "muscles": ["Lats", "Biceps"], "equipment": ["Pull-up Bar"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Chin-ups.jpg?width=480", "license_author": None},
    {"id": 900008, "name": "Push-Up", "category": "Chest", "muscles": ["Chest", "Triceps", "Shoulders"], "equipment": ["Bodyweight"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Girl%20doing%20push-ups.jpg?width=480", "license_author": None},
    {"id": 900009, "name": "Plank", "category": "Core", "muscles": ["Abs", "Core"], "equipment": ["Bodyweight"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Plank.jpg?width=480", "license_author": None},
    {"id": 900010, "name": "Walking Lunge", "category": "Legs", "muscles": ["Quadriceps", "Glutes"], "equipment": ["Bodyweight", "Dumbbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Stockholm%20HYROX%20lunges.jpg?width=480", "license_author": None},
    {"id": 900011, "name": "Leg Press", "category": "Legs", "muscles": ["Quadriceps", "Glutes"], "equipment": ["Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Young%20man%20using%20a%20leg%20press%20machine%20at%20the%20gym.jpg?width=480", "license_author": None},
    {"id": 900012, "name": "Leg Curl", "category": "Legs", "muscles": ["Hamstrings"], "equipment": ["Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/LyingLegCurlMachineExercise.JPG?width=480", "license_author": None},
    {"id": 900013, "name": "Leg Extension", "category": "Legs", "muscles": ["Quadriceps"], "equipment": ["Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/LegExtensionMachineExercise.JPG?width=480", "license_author": None},
    {"id": 900014, "name": "Standing Calf Raise", "category": "Legs", "muscles": ["Calves"], "equipment": ["Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/DumbbellStandingCalfRaise.JPG?width=480", "license_author": None},
    {"id": 900015, "name": "Lat Pulldown", "category": "Back", "muscles": ["Lats", "Biceps"], "equipment": ["Cable Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Girl%20doing%20lat%20pulldown%20exercise.jpg?width=480", "license_author": None},
    {"id": 900016, "name": "Seated Cable Row", "category": "Back", "muscles": ["Upper Back", "Lats"], "equipment": ["Cable Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Woman%20using%20a%20seated%20cable%20row%20machine%20at%20the%20gym.jpg?width=480", "license_author": None},
    {"id": 900017, "name": "Dumbbell Bicep Curl", "category": "Arms", "muscles": ["Biceps"], "equipment": ["Dumbbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Dumbbell%20bicep%20curls.jpg?width=480", "license_author": None},
    {"id": 900018, "name": "Triceps Pushdown", "category": "Arms", "muscles": ["Triceps"], "equipment": ["Cable Machine"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/CableMachinePushdown.JPG?width=480", "license_author": None},
    {"id": 900019, "name": "Dumbbell Shoulder Press", "category": "Shoulders", "muscles": ["Shoulders", "Triceps"], "equipment": ["Dumbbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Girl%20doing%20dumbbell%20shoulder%20press.jpg?width=480", "license_author": None},
    {"id": 900020, "name": "Lateral Raise", "category": "Shoulders", "muscles": ["Shoulders"], "equipment": ["Dumbbell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/DumbbellLateralRaise.JPG?width=480", "license_author": None},
    {"id": 900021, "name": "Face Pull", "category": "Shoulders", "muscles": ["Rear Delts", "Upper Back"], "equipment": ["Cable Machine"], "image_url": None, "license_author": None},
    {"id": 900022, "name": "Hip Thrust", "category": "Legs", "muscles": ["Glutes", "Hamstrings"], "equipment": ["Barbell", "Bench"], "image_url": None, "license_author": None},
    {"id": 900023, "name": "Romanian Deadlift", "category": "Legs", "muscles": ["Hamstrings", "Glutes"], "equipment": ["Barbell"], "image_url": None, "license_author": None},
    {"id": 900024, "name": "Incline Bench Press", "category": "Chest", "muscles": ["Upper Chest", "Shoulders", "Triceps"], "equipment": ["Barbell", "Incline Bench"], "image_url": None, "license_author": None},
    {"id": 900025, "name": "Dip", "category": "Chest", "muscles": ["Chest", "Triceps"], "equipment": ["Dip Bars"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Dips.jpg?width=480", "license_author": None},
    {"id": 900026, "name": "Mountain Climber", "category": "Core", "muscles": ["Abs", "Core"], "equipment": ["Bodyweight"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Airmen%20perform%20%22mountain%20climbers%22.jpg?width=480", "license_author": None},
    {"id": 900027, "name": "Burpee", "category": "Cardio", "muscles": ["Full Body"], "equipment": ["Bodyweight"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Airborne%20Burpee.jpg?width=480", "license_author": None},
    {"id": 900028, "name": "Kettlebell Swing", "category": "Legs", "muscles": ["Glutes", "Hamstrings", "Core"], "equipment": ["Kettlebell"], "image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Kettlebell%20swing%20with%20arms%20fully%20extended.jpg?width=480", "license_author": None},
]

# ---------------------------------------------------------------------------
# Short, humanized "how to perform it" cues — one every WORKOUT_PLANS
# exercise name and every POPULAR_EXERCISES entry resolves to, keyed by the
# lowercased exercise name (see routers/discover.py's normalize_exercise_name).
# Exists because a single static photo often can't show the actual movement
# (a squat photo doesn't convey "keep your chest up," a plank photo doesn't
# convey "don't let your hips sag") — this is the text fallback/companion
# for that, not a replacement for the photo. Bilingual, same {"en", "ro"}
# shape as every other piece of hand-authored content in this file, and
# localized the same way (see discover.py's _localize_plan /
# _localize_exercise). Deliberately short (one plain sentence, occasionally
# two) — a form cue, not a full technique article.
# ---------------------------------------------------------------------------
EXERCISE_HOW_TO = {
    "bench press": {
        "en": "Lie flat on the bench, lower the bar to your mid-chest with control, then press it back up over your shoulders without bouncing it off your chest.",
        "ro": "Întins pe bancă, coboară bara controlat până la mijlocul pieptului, apoi împinge-o înapoi deasupra umerilor, fără să o arunci de pe piept.",
    },
    "dumbbell bench press": {
        "en": "Same movement as a barbell bench press, one dumbbell per hand — press both up together and let your elbows travel slightly out to the sides as you lower.",
        "ro": "Aceeași mișcare ca la presa cu bara, dar cu o gantera în fiecare mână — împinge-le împreună în sus și lasă coatele să meargă puțin în lateral la coborâre.",
    },
    "incline bench press": {
        "en": "Same as a flat bench press but on an inclined bench (around 30-45°), which shifts more of the work onto your upper chest and front shoulders.",
        "ro": "La fel ca presa pe bancă plată, dar pe o bancă înclinată (cam 30-45°), ceea ce mută o parte din efort spre partea superioară a pieptului și umerii din față.",
    },
    "incline dumbbell press": {
        "en": "Incline bench press using a dumbbell in each hand — press them up and slightly together at the top, lower with control to chest level.",
        "ro": "Presă înclinată cu câte o gantera în fiecare mână — împinge-le în sus și puțin una spre alta la vârf, coboară controlat până la nivelul pieptului.",
    },
    "overhead press": {
        "en": "Standing, press the bar from your upper chest straight overhead until your arms lock out, keeping your core tight so you don't arch your lower back.",
        "ro": "În picioare, împinge bara de la piept drept deasupra capului până când brațele sunt întinse, cu abdomenul contractat ca să nu arcuiești spatele.",
    },
    "dumbbell shoulder press": {
        "en": "Same as an overhead press, one dumbbell in each hand — press both straight up and bring them back to shoulder height with control.",
        "ro": "La fel ca presa deasupra capului, dar cu câte o gantera în fiecare mână — împinge-le drept în sus și adu-le înapoi controlat la nivelul umerilor.",
    },
    "lateral raise": {
        "en": "Standing with a light dumbbell in each hand, raise your arms out to the sides until they're roughly shoulder height, then lower slowly — this is a shoulder isolation move, so keep the weight light and controlled.",
        "ro": "În picioare, cu câte o gantera ușoară în fiecare mână, ridică brațele lateral până la înălțimea umerilor, apoi coboară lent — e o mișcare de izolare, așa că folosește o greutate mică și controlată.",
    },
    "rear delt fly": {
        "en": "Hinge forward at the hips with a slight bend in the knees, then raise the dumbbells out to the sides squeezing your shoulder blades together at the top.",
        "ro": "Apleacă-te ușor din șolduri, cu genunchii puțin îndoiți, apoi ridică ganterele lateral, strângând omoplații la vârful mișcării.",
    },
    "face pull": {
        "en": "Pull a cable/band toward your face at eye level, elbows high and out wide, focusing on squeezing your rear shoulders and upper back together.",
        "ro": "Trage un cablu/bandă spre față, la nivelul ochilor, cu coatele sus și larg, concentrându-te pe strângerea umerilor din spate și a spatelui superior.",
    },
    "barbell row": {
        "en": "Hinge forward with a flat back, pull the bar up to your lower ribs/upper stomach, squeezing your shoulder blades together, then lower with control.",
        "ro": "Apleacă-te înainte cu spatele drept, trage bara spre coastele inferioare/abdomenul superior, strângând omoplații, apoi coboară controlat.",
    },
    "dumbbell row": {
        "en": "One hand and knee on a bench for support, pull the dumbbell straight up toward your hip, leading with your elbow, then lower with control.",
        "ro": "Cu o mână și un genunchi sprijinite pe bancă, trage gantera drept în sus spre șold, conducând cu cotul, apoi coboară controlat.",
    },
    "renegade row": {
        "en": "In a push-up plank position with a dumbbell in each hand, row one dumbbell up to your hip while balancing on the other arm, keeping your hips as still and square as possible.",
        "ro": "În poziție de plank cu câte o gantera în fiecare mână, ridică una spre șold în timp ce te sprijini pe celălalt braț, ținând șoldurile cât mai nemișcate și drepte.",
    },
    "seated cable row": {
        "en": "Sitting with knees slightly bent, pull the handle straight to your stomach while keeping your back upright, then extend your arms back out with control.",
        "ro": "Așezat, cu genunchii ușor îndoiți, trage mânerul drept spre abdomen ținând spatele drept, apoi întinde brațele înapoi, controlat.",
    },
    "lat pulldown": {
        "en": "Pull the bar down to your upper chest, leading with your elbows and squeezing your lats, rather than yanking it down with your arms alone.",
        "ro": "Trage bara în jos spre partea superioară a pieptului, conducând cu coatele și contractând mușchii dorsali, nu doar trăgând cu brațele.",
    },
    "pull-up": {
        "en": "Hang from the bar with hands just outside shoulder width, pull your chin above the bar leading with your chest, then lower fully under control.",
        "ro": "Atârnă de bară cu mâinile puțin peste lățimea umerilor, trage-te cu bărbia deasupra barei conducând cu pieptul, apoi coboară complet, controlat.",
    },
    "chin-up": {
        "en": "Same as a pull-up but with palms facing you (underhand grip) — this recruits more biceps while still working your back.",
        "ro": "La fel ca la tracțiuni, dar cu palmele spre tine (priză supinată) — implică mai mult bicepsul, lucrând totuși spatele.",
    },
    "triceps dip": {
        "en": "Support yourself on parallel bars/a bench, lower your body by bending your elbows to roughly 90°, then press back up — lean slightly forward to keep the emphasis on triceps and chest, not shoulders.",
        "ro": "Sprijinit pe bare paralele/o bancă, coboară corpul îndoind coatele la aproximativ 90°, apoi împinge înapoi în sus — apleacă-te ușor în față ca accentul să rămână pe triceps și piept, nu pe umeri.",
    },
    "dip": {
        "en": "Support yourself on parallel bars, lower your body by bending your elbows, then press back up to full extension — stay fairly upright to bias chest over triceps.",
        "ro": "Sprijinit pe bare paralele, coboară corpul îndoind coatele, apoi împinge înapoi până la extensie completă — rămâi relativ vertical pentru a pune accent pe piept.",
    },
    "cable fly": {
        "en": "Standing between two cable stacks, bring your hands together in front of your chest in a wide, hugging arc, keeping a slight bend in your elbows throughout.",
        "ro": "În picioare, între două cabluri, adu mâinile împreună în fața pieptului într-un arc larg, ca o îmbrățișare, cu o ușoară îndoire a coatelor pe tot parcursul.",
    },
    "barbell curl": {
        "en": "Standing, curl the bar up by bending your elbows while keeping your upper arms pinned to your sides — avoid swinging your torso to help lift the weight.",
        "ro": "În picioare, ridică bara îndoind coatele, cu brațele lipite de corp — evită să legeni trunchiul pentru a ajuta ridicarea greutății.",
    },
    "dumbbell curl": {
        "en": "Same as a barbell curl, alternating or together with a dumbbell in each hand — rotate your palm to face up as you curl for a fuller biceps contraction.",
        "ro": "La fel ca la flexii cu bara, alternativ sau simultan cu câte o gantera în fiecare mână — rotește palma în sus pe măsură ce ridici, pentru o contracție mai completă a bicepsului.",
    },
    "dumbbell bicep curl": {
        "en": "Curl the dumbbells up by bending your elbows only, keeping your upper arms still against your sides, then lower slowly rather than dropping the weight.",
        "ro": "Ridică ganterele îndoind doar coatele, cu brațele lipite de corp, apoi coboară lent, fără să lași greutatea să cadă.",
    },
    "hammer curl": {
        "en": "Same as a dumbbell curl but with palms facing each other the whole time (a neutral grip) — this shifts more work onto the forearm and outer arm muscle.",
        "ro": "La fel ca flexia cu gantera, dar cu palmele față în față tot timpul (priză neutră) — pune mai mult accent pe antebraț și mușchiul din exteriorul brațului.",
    },
    "triceps pushdown": {
        "en": "Using a cable and a bar/rope attachment, push down by straightening your elbows while keeping your upper arms pinned to your sides.",
        "ro": "Cu ajutorul unui cablu și a unei bare/coarde, împinge în jos întinzând coatele, cu brațele lipite de corp.",
    },
    "cable pushdown": {
        "en": "Same movement as a triceps pushdown — elbows stay tucked at your sides, only your forearms move as you extend down and control the return.",
        "ro": "Aceeași mișcare ca la pushdown pentru triceps — coatele rămân lipite de corp, doar antebrațele se mișcă la extensie, iar revenirea e controlată.",
    },
    "skull crusher": {
        "en": "Lying down with the bar/dumbbells held above your chest, bend only your elbows to lower the weight toward your forehead, then extend back up.",
        "ro": "Întins, cu bara/ganterele deasupra pieptului, îndoaie doar coatele pentru a coborî greutatea spre frunte, apoi extinde înapoi în sus.",
    },
    "squat": {
        "en": "Feet roughly shoulder-width apart, push your hips back and bend your knees to lower down as if sitting into a chair, keeping your chest up, then drive through your heels to stand.",
        "ro": "Cu picioarele cam la lățimea umerilor, împinge șoldurile în spate și îndoaie genunchii ca și cum te-ai așeza pe un scaun, cu pieptul sus, apoi împinge prin călcâie ca să te ridici.",
    },
    "barbell back squat": {
        "en": "With the bar resting across your upper back, squat down by pushing your hips back and bending your knees, keeping your chest up, then drive back up through your heels.",
        "ro": "Cu bara sprijinită pe partea superioară a spatelui, ghemuiește-te împingând șoldurile în spate și îndoind genunchii, cu pieptul sus, apoi împinge înapoi în sus prin călcâie.",
    },
    "front squat": {
        "en": "Same squat pattern as a back squat, but with the bar resting on the front of your shoulders — this naturally keeps your torso more upright and shifts more emphasis to your quads.",
        "ro": "Același model de genuflexiune ca la back squat, dar cu bara sprijinită pe partea din față a umerilor — asta menține trunchiul mai vertical și pune mai mult accent pe cvadricepși.",
    },
    "bodyweight squat": {
        "en": "Same squat pattern with no added weight — hips back, knees bend, chest stays up, drive through your heels to stand back up.",
        "ro": "Aceeași genuflexiune, fără greutate adăugată — șoldurile în spate, genunchii se îndoaie, pieptul rămâne sus, împinge prin călcâie ca să te ridici.",
    },
    "goblet squat": {
        "en": "Hold one dumbbell/kettlebell vertically against your chest with both hands, then squat down between your knees, keeping your chest tall.",
        "ro": "Ține o gantera/kettlebell vertical la piept, cu ambele mâini, apoi ghemuiește-te între genunchi, cu pieptul drept.",
    },
    "jump squat": {
        "en": "Perform a bodyweight squat, then explode upward into a jump as you stand, landing softly back into the next squat.",
        "ro": "Execută o genuflexiune, apoi explodează în sus într-o săritură pe măsură ce te ridici, aterizând ușor înapoi în următoarea genuflexiune.",
    },
    "squat thrust": {
        "en": "From standing, squat down, place your hands on the floor and jump your feet back into a plank, then jump them back in and stand up — essentially a burpee without the push-up or jump at the top.",
        "ro": "Din picioare, ghemuiește-te, pune mâinile pe podea și sări cu picioarele în spate într-un plank, apoi sări-le înapoi și ridică-te — practic un burpee fără flotare sau săritură la final.",
    },
    "deadlift": {
        "en": "Feet hip-width apart, hinge at your hips to grip the bar, keep your back flat and chest up, then stand up by driving your hips forward — the bar should stay close to your legs the whole way.",
        "ro": "Cu picioarele la lățimea șoldurilor, apleacă-te din șolduri să prinzi bara, ține spatele drept și pieptul sus, apoi ridică-te împingând șoldurile înainte — bara trebuie să rămână aproape de picioare tot timpul.",
    },
    "dumbbell deadlift": {
        "en": "Same hip-hinge pattern as a barbell deadlift, one dumbbell in each hand close to your legs — keep your back flat and drive up through your heels.",
        "ro": "Același model de aplecare din șolduri ca la deadlift cu bara, dar cu câte o gantera în fiecare mână, aproape de picioare — ține spatele drept și împinge prin călcâie.",
    },
    "romanian deadlift": {
        "en": "Starting standing with the bar at hip height, push your hips back while keeping your legs almost straight and the bar close to your body, lowering until you feel a stretch in your hamstrings, then drive your hips forward to stand.",
        "ro": "Pornind în picioare cu bara la nivelul șoldurilor, împinge șoldurile în spate cu picioarele aproape întinse și bara aproape de corp, coboară până simți întindere în ischiogambieri, apoi împinge șoldurile înainte ca să te ridici.",
    },
    "dumbbell romanian deadlift": {
        "en": "Same hip-hinge as a barbell Romanian deadlift, a dumbbell in each hand — legs nearly straight, push your hips back until you feel your hamstrings stretch, then stand back up.",
        "ro": "Aceeași aplecare din șolduri ca la RDL cu bara, dar cu câte o gantera în fiecare mână — picioarele aproape întinse, împinge șoldurile în spate până simți întinderea în ischiogambieri, apoi ridică-te.",
    },
    "leg press": {
        "en": "Sitting in the machine, push the platform away by extending your knees and hips, then lower it back under control until your knees approach a 90° bend.",
        "ro": "Așezat la aparat, împinge platforma îndreptând genunchii și șoldurile, apoi coboar-o controlat până genunchii ajung aproape de 90°.",
    },
    "leg curl": {
        "en": "Lying face down (or seated, depending on the machine), curl your heels toward your glutes by bending your knees, then lower with control.",
        "ro": "Culcat pe burtă (sau așezat, în funcție de aparat), adu călcâiele spre fesier îndoind genunchii, apoi coboară controlat.",
    },
    "leg extension": {
        "en": "Sitting in the machine, extend your knees to lift the pad until your legs are straight, then lower back down with control rather than letting the weight drop.",
        "ro": "Așezat la aparat, întinde genunchii pentru a ridica suportul până picioarele sunt drepte, apoi coboară controlat, fără să lași greutatea să cadă.",
    },
    "standing calf raise": {
        "en": "Standing on the balls of your feet on a platform/machine, rise up as high as possible onto your toes, pause, then lower your heels below the platform for a full stretch.",
        "ro": "În picioare, pe vârfuri, pe o platformă/aparat, ridică-te cât mai sus pe degete, oprește-te scurt, apoi coboară călcâiele sub platformă pentru o întindere completă.",
    },
    "hip thrust": {
        "en": "Upper back resting on a bench with the bar over your hips, drive your hips up until your body forms a straight line from shoulders to knees, squeezing your glutes at the top.",
        "ro": "Cu partea superioară a spatelui sprijinită pe bancă și bara peste șolduri, împinge șoldurile în sus până corpul formează o linie dreaptă de la umeri la genunchi, contractând fesierii la vârf.",
    },
    "glute bridge": {
        "en": "Lying on your back with knees bent and feet flat, drive your hips up toward the ceiling by squeezing your glutes, then lower with control.",
        "ro": "Culcat pe spate, cu genunchii îndoiți și tălpile pe podea, împinge șoldurile spre tavan contractând fesierii, apoi coboară controlat.",
    },
    "lunge": {
        "en": "Step forward and lower your body until both knees are bent around 90°, keeping your torso upright, then push back through your front foot to return to standing.",
        "ro": "Fă un pas înainte și coboară corpul până ambii genunchi sunt îndoiți la aproximativ 90°, cu trunchiul drept, apoi împinge prin piciorul din față ca să revii în picioare.",
    },
    "walking lunge": {
        "en": "Same lunge pattern, but instead of stepping back you step forward into the next lunge each time, alternating legs as you travel forward.",
        "ro": "Același model de fandare, dar în loc să revii, pășești înainte în următoarea fandare de fiecare dată, alternând picioarele pe măsură ce avansezi.",
    },
    "lunge jump": {
        "en": "From a lunge position, jump up and switch your legs mid-air, landing back in a lunge with the opposite leg forward.",
        "ro": "Din poziția de fandare, sari și schimbă picioarele în aer, aterizând tot în fandare, dar cu piciorul opus în față.",
    },
    "kettlebell swing": {
        "en": "Hinge at your hips to swing the kettlebell back between your legs, then snap your hips forward explosively to swing it up to chest height — the power comes from your hips, not your arms.",
        "ro": "Apleacă-te din șolduri pentru a duce kettlebell-ul în spate printre picioare, apoi împinge exploziv șoldurile înainte ca să-l ridici la nivelul pieptului — forța vine din șolduri, nu din brațe.",
    },
    "push-up": {
        "en": "Hands roughly shoulder-width apart in a plank position, lower your whole body as one unit until your chest nearly touches the floor, then push back up.",
        "ro": "Cu mâinile cam la lățimea umerilor, în poziție de plank, coboară tot corpul ca un bloc unitar până pieptul aproape atinge podeaua, apoi împinge înapoi în sus.",
    },
    "diamond push-up": {
        "en": "Same as a push-up, but with your hands close together under your chest forming a diamond shape with your thumbs and index fingers — this shifts more emphasis onto your triceps.",
        "ro": "La fel ca flotarea normală, dar cu mâinile apropiate sub piept, formând un romb cu degetele mari și arătătoarele — pune mai mult accent pe triceps.",
    },
    "pike push-up": {
        "en": "Start in a downward-dog-like position with your hips high, then bend your elbows to lower the top of your head toward the floor, and press back up — a beginner-friendly way to build overhead-press strength.",
        "ro": "Pornește într-o poziție asemănătoare cu downward dog, cu șoldurile sus, apoi îndoaie coatele pentru a coborî creștetul capului spre podea și împinge înapoi în sus — un mod accesibil de a construi forța pentru presa deasupra capului.",
    },
    "plank": {
        "en": "Hold your body in a straight line from head to heels, supported on your forearms and toes, keeping your hips level — don't let them sag or pike up.",
        "ro": "Ține corpul într-o linie dreaptă de la cap la călcâie, sprijinit pe antebrațe și vârful picioarelor, cu șoldurile la același nivel — nu le lăsa să cadă sau să se ridice prea mult.",
    },
    "side plank": {
        "en": "Lying on your side, prop yourself up on one forearm with your body in a straight line, hips lifted off the floor — hold without letting your hips drop.",
        "ro": "Culcat pe o parte, sprijină-te pe un antebraț cu corpul într-o linie dreaptă, șoldurile ridicate de pe podea — menține poziția fără să lași șoldurile să coboare.",
    },
    "plank shoulder tap": {
        "en": "From a plank position, alternate tapping each shoulder with the opposite hand, keeping your hips as still and square as possible to resist rotating.",
        "ro": "Din poziția de plank, atinge alternativ fiecare umăr cu mâna opusă, ținând șoldurile cât mai nemișcate și drepte, ca să reziști rotației.",
    },
    "wall sit": {
        "en": "Lean your back against a wall and slide down until your knees are bent around 90°, as if sitting in an invisible chair, and hold the position.",
        "ro": "Sprijină spatele de un perete și alunecă în jos până genunchii sunt îndoiți la aproximativ 90°, ca și cum ai sta pe un scaun invizibil, și menține poziția.",
    },
    "superman": {
        "en": "Lying face down with arms extended forward, simultaneously lift your arms, chest, and legs a few inches off the floor, squeezing your lower back and glutes, then lower with control.",
        "ro": "Culcat pe burtă, cu brațele întinse înainte, ridică simultan brațele, pieptul și picioarele câțiva centimetri de pe podea, contractând partea inferioară a spatelui și fesierii, apoi coboară controlat.",
    },
    "bicycle crunch": {
        "en": "Lying on your back, bring one elbow toward the opposite knee while extending the other leg out, then alternate sides in a pedaling motion.",
        "ro": "Culcat pe spate, adu un cot spre genunchiul opus în timp ce întinzi celălalt picior, apoi alternează părțile într-o mișcare de pedalare.",
    },
    "mountain climber": {
        "en": "From a plank position, drive your knees toward your chest one at a time in a quick running-like motion, keeping your hips low and core braced.",
        "ro": "Din poziția de plank, adu genunchii spre piept pe rând, într-o mișcare rapidă ca de alergare, cu șoldurile jos și abdomenul contractat.",
    },
    "jumping jacks": {
        "en": "Jump your feet out while raising your arms overhead, then jump back to standing with arms at your sides — a simple, rhythmic full-body warm-up/cardio move.",
        "ro": "Sari cu picioarele în lateral în timp ce ridici brațele deasupra capului, apoi revino sărind cu brațele pe lângă corp — o mișcare simplă, ritmică, de încălzire/cardio pentru tot corpul.",
    },
    "high knees": {
        "en": "Run in place, driving your knees up toward hip height as quickly as you can while pumping your arms.",
        "ro": "Aleargă pe loc, ridicând genunchii spre nivelul șoldurilor cât de repede poți, mișcând brațele în ritm.",
    },
    "burpee": {
        "en": "Squat down, kick your feet back into a plank, do a push-up, jump your feet back in, then explode up into a jump — one continuous full-body movement.",
        "ro": "Ghemuiește-te, aruncă picioarele în spate într-un plank, fă o flotare, adu picioarele înapoi, apoi explodează într-o săritură — o mișcare continuă pentru tot corpul.",
    },
    "skater jump": {
        "en": "Jump laterally from one leg to the other in a skating motion, landing softly on the outside leg each time to work balance and side-to-side power.",
        "ro": "Sari lateral de pe un picior pe altul, ca la patinaj, aterizând ușor pe piciorul exterior de fiecare dată, pentru echilibru și forță laterală.",
    },
    "sprint in place": {
        "en": "Run in place as fast as you can, driving your knees and arms with intensity — treat it like an all-out sprint, just without covering ground.",
        "ro": "Aleargă pe loc cât de repede poți, mișcând genunchii și brațele cu intensitate — tratează-l ca pe un sprint total, doar că fără deplasare.",
    },
    "dumbbell thruster": {
        "en": "Hold a dumbbell at each shoulder, squat down, then drive up explosively through your legs and press the dumbbells overhead in one continuous motion.",
        "ro": "Ține câte o gantera la fiecare umăr, ghemuiește-te, apoi împinge exploziv din picioare și presează ganterele deasupra capului, într-o mișcare continuă.",
    },
    "cat-cow stretch": {
        "en": "On hands and knees, alternate between arching your back up toward the ceiling (cat) and dipping your belly down while lifting your head (cow), moving slowly with your breath.",
        "ro": "În patru labe, alternează între arcuirea spatelui spre tavan (cat) și coborârea abdomenului cu ridicarea capului (cow), mișcându-te lent, în ritmul respirației.",
    },
    "world's greatest stretch": {
        "en": "From a deep lunge, place both hands on the floor inside your front foot, then rotate your torso and reach one arm up toward the ceiling — a full-body mobility combo move.",
        "ro": "Dintr-o fandare adâncă, pune ambele mâini pe podea, lângă piciorul din față, apoi rotește trunchiul și întinde un braț spre tavan — o mișcare combinată de mobilitate pentru tot corpul.",
    },
    "hip flexor stretch": {
        "en": "Kneel with one leg forward in a lunge position, gently push your hips forward while keeping your torso upright until you feel a stretch at the front of the hip of the kneeling leg.",
        "ro": "Îngenunchează cu un picior în față, în poziție de fandare, împinge ușor șoldurile înainte cu trunchiul drept, până simți întindere în fața șoldului piciorului din spate.",
    },
    "thoracic spine rotation": {
        "en": "On hands and knees (or side-lying), thread one arm under your body and rotate it back up toward the ceiling, following the movement with your eyes to open up your upper back.",
        "ro": "În patru labe (sau culcat pe o parte), treci un braț pe sub corp și rotește-l înapoi spre tavan, urmărind mișcarea cu privirea pentru a deschide partea superioară a spatelui.",
    },
    "downward dog": {
        "en": "From hands and feet, push your hips up and back to form an inverted V-shape, pressing your heels toward the floor and your chest toward your thighs.",
        "ro": "Din poziția pe mâini și picioare, împinge șoldurile în sus și în spate pentru a forma un V inversat, apăsând călcâiele spre podea și pieptul spre coapse.",
    },
    "foam rolling — quads & back": {
        "en": "Slowly roll a foam roller under the target muscle, pausing on tender spots for a few seconds to let the tension release, rather than rolling quickly back and forth.",
        "ro": "Rulează încet un foam roller sub mușchiul vizat, oprindu-te câteva secunde pe zonele sensibile pentru a lăsa tensiunea să se elibereze, în loc să rulezi rapid înainte-înapoi.",
    },
}


def normalize_exercise_name(name: str) -> str:
    return name.strip().lower()


def exercise_how_to(name: str, language: str = "en") -> str | None:
    """Looks up EXERCISE_HOW_TO by normalized name, returning the requested
    language (falling back to English if a translation is somehow missing).
    None if this exercise name has no curated cue at all — callers decide
    what None means for them (e.g. a live wger search result falls back to
    wger's own description instead, see routers/discover.py)."""
    entry = EXERCISE_HOW_TO.get(normalize_exercise_name(name))
    if not entry:
        return None
    return entry.get(language) or entry.get("en")
