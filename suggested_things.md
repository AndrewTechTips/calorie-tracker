<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon/ont_banner_top_light.png">
    <img alt="OpenNutriTracker" src="assets/icon/ont_banner_top.png" width="420" />
  </picture>
</p>

<p align="center">
  <b>Free. Open. Cited.</b><br />
  Open-source calorie, macro, and micronutrient logging for Android and iOS.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-GPLv3-22de5f?style=flat-square" /></a>
  <a href="https://github.com/simonoppowa/OpenNutriTracker/releases"><img alt="Release" src="https://img.shields.io/github/v/release/simonoppowa/OpenNutriTracker?style=flat-square&color=22de5f" /></a>
  <a href="https://github.com/simonoppowa/OpenNutriTracker/actions/workflows/default_workflow.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/simonoppowa/OpenNutriTracker/default_workflow.yml?branch=main&style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey?style=flat-square" />
  <a href="https://hosted.weblate.org/engage/opennutritracker/"><img alt="Translation status" src="https://img.shields.io/weblate/progress/opennutritracker?server=https%3A%2F%2Fhosted.weblate.org&style=flat-square&color=22de5f&label=translated" /></a>
  <a href="https://github.com/simonoppowa/OpenNutriTracker/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/simonoppowa/OpenNutriTracker?style=flat-square" /></a>
  <a href="https://github.com/simonoppowa/OpenNutriTracker/issues"><img alt="Issues" src="https://img.shields.io/github/issues/simonoppowa/OpenNutriTracker?style=flat-square" /></a>
  <a href="https://github.com/simonoppowa/OpenNutriTracker/pulls"><img alt="Pull requests" src="https://img.shields.io/github/issues-pr/simonoppowa/OpenNutriTracker?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/12625"><img alt="simonoppowa/OpenNutriTracker | Trendshift" src="https://trendshift.io/api/badge/repositories/12625" width="250" height="55" /></a>
  &nbsp;
  <a href="https://trendshift.io/repositories/12625"><img alt="#2 Dart Repository Of The Day | Trendshift" src="https://trendshift.io/api/badge/trendshift/repositories/12625/daily?language=Dart" width="250" height="55" /></a>
</p>

<p align="center">
  <a href="https://simonoppowa.github.io/OpenNutriTracker/">Website</a>
  ·
  <a href="GettingStarted.md">Getting started</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://hosted.weblate.org/engage/opennutritracker/">Translate</a>
</p>

OpenNutriTracker logs what you eat and drink against a calorie and macro target it works
out from your height, weight, age, and activity level, and keeps the record on your phone.
It is for anyone who wants the numbers without handing their eating history to a company,
whether that is losing weight, gaining it, managing a condition, or simply knowing.

## Install

<p align="center">
  <a href="https://apps.apple.com/us/app/opennutritracker/id6451490901"><img alt="Download on the App Store" src="fastlane/metadata/android/en-US/images/appstore_banner.png" height="54" /></a>
  &nbsp;&nbsp;
  <a href="https://play.google.com/store/apps/details?id=com.opennutritracker.ont.opennutritracker"><img alt="Get it on Google Play" src="fastlane/metadata/android/en-US/images/playstore_banner.png" height="54" /></a>
</p>

## Screenshots

<table align="center">
  <tr>
    <td align="center" width="33%"><img alt="Home screen showing calories left on a progress ring, carbs, fat and protein against their targets, and the day's logged activity" src="docs/site/screenshots/1_en-US.png" /></td>
    <td align="center" width="33%"><img alt="Adding food to lunch, with recently logged items ready to re-add in one tap and a barcode scanner in the search field" src="docs/site/screenshots/2_en-US.png" /></td>
    <td align="center" width="33%"><img alt="Food detail showing the full nutrition table with saturated fat, sugar and fibre, plus an expanded micronutrient panel" src="docs/site/screenshots/3_en-US.png" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Home</b><br />where the day stands</sub></td>
    <td align="center"><sub><b>Add food</b><br />re-log in one tap</sub></td>
    <td align="center"><sub><b>Food detail</b><br />down to the micronutrient</sub></td>
  </tr>
  <tr>
    <td align="center"><img alt="Diary showing a month calendar with each day marked by how it went, and the selected day's calories and macro rings below" src="docs/site/screenshots/4_en-US.png" /></td>
    <td align="center"><img alt="Trends showing a seven-day streak, calories charted against the goal line, and daily macro averages" src="docs/site/screenshots/5_en-US.png" /></td>
    <td align="center"><img alt="Profile screen showing BMI, activity level, weight goal and weekly rate" src="docs/site/screenshots/6_en-US.png" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Diary</b><br />every day you've logged</sub></td>
    <td align="center"><sub><b>Trends</b><br />calories against your goal</sub></td>
    <td align="center"><sub><b>You</b><br />goals and body metrics</sub></td>
  </tr>
</table>

<sub>Screenshots show a demo profile with generated data.</sub>

## Why OpenNutriTracker

|  | |
| :-- | :-- |
| **Cited** | Calorie targets follow IOM 2005, BMI follows WHO, macros follow WHO TRS 916, activity burn follows the 2024 Compendium. The in-app Sources & References screen links every paper ([`sources_screen.dart`](lib/core/presentation/sources_screen.dart)). |
| **Careful** | The fasting timer opens with a content warning linking BEAT and NEDA, and "Not for me" is a first-class answer ([`fasting_warning_dialog.dart`](lib/features/fasting/presentation/widgets/fasting_warning_dialog.dart)). No streak guilt, and no notification you didn't ask for. The daily reminder is off until you enable it. |
| **Free** | No paid tier and no ads, with zero advertising or analytics SDKs in [`pubspec.yaml`](pubspec.yaml) to add them with. That includes the micronutrient panel the big-name trackers put behind a subscription. No investors, and GPLv3 leaves no exit that could paywall it later. |
| **Private** | No account to create. Your diary lives in AES-256-encrypted storage with the key held in the Android Keystore / iOS Keychain, every destination that receives a request is listed under [Privacy](#privacy) with what it's sent, and the release signing fingerprint is published so you can verify your download. |
| **Portable** | Export your diary, activities, recipes, custom meals and weight history as JSON or CSV, re-import it, or share an entry by QR. The [export format](docs/export-format.md) documents the schema and what it leaves out. |
| **Open** | Open Food Facts, USDA FoodData Central (CC0) and the German BLS (CC BY 4.0). The backend is its own open repository you can [self-host](docs/supabase-self-hosting.md). |
| **Community driven** | Over 30 developers have already contributed code, and most merged pull requests come from someone other than the maintainer. Features and fixes arrive as user issues and PRs, across the app and its food backend, and every translation is contributed on [Weblate](https://hosted.weblate.org/engage/opennutritracker/), which needs no Dart and no local setup. |
| **Inclusive** | Non-binary calorie estimation grounded in published trans-health research, nine languages, kcal or kJ, and screen-reader support treated as a bug when it breaks. |

## Key features

|  | Feature | |
| :--: | :-- | :-- |
| 🍎 | **Food logging** | Search, scan a barcode, or quick-add kcal, backed by Open Food Facts, USDA, and German BLS. |
| 📓 | **Food diary** | Breakfast, Lunch, Dinner, and Snack on a calendar, with per-meal kcal targets. |
| 📈 | **Trends** | Streaks, calories against your goal line, macro averages, water, and weight over time. |
| 🥕 | **Micronutrients** | Day and week views for ten nutrients, with optional reference-intake bars. |
| 🍽️ | **Meals and recipes** | Reusable recipes with photo, brand, and barcode. |
| 🏃 | **Activities and weight** | Workout catalogue or custom activities; weight trend against a target. |
| 💧 | **Water and fasting** | A home-screen water chip and an optional intermittent-fasting timer. |
| 🎨 | **Themes and units** | Material You accent on Android 12+, sixteen built-in themes, kcal or kJ. |
| 📤 | **Export and import** | JSON and CSV export, JSON import, and QR sharing. |

<details>
<summary>More detail on each feature</summary>

- **🍎 Nutritional tracking:** Log meals and snacks against a large food database: Open Food Facts plus a multi-source reference backend covering USDA FoodData Central and the German Bundeslebensmittelschlüssel (BLS), with the sources selectable in Settings → Food databases. Each entry can be searched, scanned, or added straight as a number when you already know the calorie cost.
- **📓 Food diary:** A calendar-driven diary that breaks the day into Breakfast, Lunch, Dinner, and Snack, with per-meal kcal targets (Standard, OMAD, Five-small, Mediterranean, Two-meal, or a custom share), drag-to-rearrange between meals, and sort by time or by macro contribution.
- **📈 Trends:** A current and best day-streak card, calories charted against your goal line, daily macro averages, water intake, and weight against target with an estimate of the weeks left to reach it. Switch the window between 7, 30 and 90 days or your whole history.
- **🥕 Micronutrient panel:** Day and week views for fibre, sodium, saturated fat, sugar, calcium, iron, potassium, vitamin D, vitamin B12, and magnesium, with optional Dietary Reference Intake bars from the IOM tables so you can see where you sit against the reference range.
- **🍽️ Custom meals + recipes:** Build a one-off custom meal or save a reusable recipe with photo, brand, and barcode. The recipe builder has its own ingredient picker with barcode scanning so you can compose meals from real products without leaving the screen.
- **⚡ Quick add:** When you already know roughly how much you ate, skip the search flow entirely. Quick add takes a title plus kcal (and optional macros) and logs it straight to the meal section.
- **📷 Barcode scanner:** Scan packaged items for instant lookup, paste a barcode manually when the camera struggles, or attach a barcode to a custom meal so future scans recognise your own foods.
- **🏃 Activities:** Log workouts from a categorised activity catalogue or define your own custom activities with direct kcal entry and reusable templates.
- **💧 Water tracker:** A water chip on the home screen with quick-add increments, an editable goal, and undo for the last entry.
- **⏱️ Fasting timer:** Optional intermittent-fasting timer with content-warning gate, a home chip showing time remaining, and a completion notification when you reach your window.
- **⚖️ Weight history:** Capture weight during onboarding and on demand, see the trend on a chart with a dashed line at your target weight, and optionally taper the calorie goal as you approach it.
- **🎨 Material You + theme picker:** Adopt the system accent colour on Android 12+, or pick from sixteen built-in presets. The app icon adapts to iOS dark and tinted appearances and to Android themed icons.
- **🔢 kcal or kJ:** Switch the energy unit globally; every diary entry, target, and chart reflects the choice.
- **📤 Export and import:** Export your diary entries, activities, tracked days, and recipes to a JSON zip, with flat CSV companions for the first three so a spreadsheet can read them ([bundle format](docs/export-format.md)). Paste a JSON blob to import meals, and share a single meal or activity as a QR code another phone can scan. Your profile, weight log, custom-meal catalogue, activity templates, water and fasting history stay out of the bundle.

</details>

## Privacy

No account, no sign-in, no analytics, no ads. Your profile, diary, activities, weight, water and fasting history, custom meals, and recipes live in local [Hive](https://pub.dev/packages/hive_ce) boxes encrypted with AES-256. The key is generated on first launch, kept in the Android Keystore / iOS Keychain, and never transmitted ([source](lib/core/utils/secure_app_storage_provider.dart)). **Settings → Delete all my data** wipes the active profile. Formal policy: [Data Protection](https://www.iubenda.com/privacy-policy/53501884).

**What leaves your device.** Three destinations, nothing else:

| Destination | When | What is sent |
| :-- | :-- | :-- |
| [Open Food Facts](https://world.openfoodfacts.org/) | Food search or barcode scan | The search term or barcode, plus a country tag from your device locale for ranking |
| Supabase reference backend | Food search | The search term |
| [Sentry](https://sentry.io) | **Only if you opt in** | Crash traces, app and OS version, device model |

[USDA FoodData Central](https://fdc.nal.usda.gov/), the German [BLS](https://www.blsdb.de), INDB and TBCA are where the food *data* comes from, not places your device talks to. Those datasets are ingested into the Supabase backend ahead of time ([self-hosting guide](docs/supabase-fdc-self-hosting.md)), so a search reaches that backend and stops there. Settings → Food databases chooses which datasets a search covers. Five are selectable today, with INDB and TBCA in the schema but not yet carrying data ([`sp_const.dart`](lib/features/add_meal/data/dto/sp/sp_const.dart)).

Requests carry a User-Agent naming the app, platform, and version, with no user or device identifier. Search results are cached locally and pruned after 90 days.

**Crash reporting** is off until you enable it, and initializes only in release builds ([`main.dart:119`](lib/main.dart:119)). `sendDefaultPii` stays `false`, so no username, email, or IP-derived identity is attached. Disabling it, or deleting your data, closes the SDK immediately.

**Permissions:** camera (barcode scanning, meal photos), photo library (meal photos, exports), notifications (daily reminder, fasting timer), internet (food lookups), and receive-boot-completed (re-registering the reminder after a reboot). No location, contacts, microphone, or health-data access.

**Not collected:** no account, email, or phone number. The backend is read with an anonymous key and there is no sign-in path. No advertising ID and no cross-app tracking: `NSPrivacyTracking` is `false` with an empty tracking-domains list, and crash and performance data are declared *not linked to the user* ([`PrivacyInfo.xcprivacy`](ios/Runner/PrivacyInfo.xcprivacy)).

<details>
<summary><b>Verifying APK signatures</b></summary>

If you are side-loading an OpenNutriTracker APK from GitHub Releases, or from F-Droid once the app is published there, you may want to confirm that the file you downloaded was signed by the same key used for every official release, rather than by someone who intercepted the download or repackaged the app.

The official SHA256 fingerprint of the Android release signing certificate is:

```
SHA256: 84:E8:60:74:EC:7E:DA:BB:10:F2:01:79:86:DD:F0:9E:53:1C:AF:7A:73:08:0A:C1:17:2B:80:C4:9C:62:08:27
```

To verify a downloaded APK against that fingerprint, run:

```sh
apksigner verify --print-certs /path/to/opennutritracker.apk
```

The `SHA-256` line in the output should match the value above exactly.

</details>

## Translations

OpenNutriTracker is translated on [Hosted Weblate](https://hosted.weblate.org/engage/opennutritracker/). Translating needs no local setup and no Dart. Pick a language, edit the strings in the browser, and Weblate syncs the result back to this repository.

<p align="center">
  <a href="https://hosted.weblate.org/engage/opennutritracker/"><img alt="Translation status per language" src="https://hosted.weblate.org/widget/opennutritracker/multi-auto.svg" /></a>
</p>

To start a language that isn't listed yet, request it from the [Weblate project page](https://hosted.weblate.org/projects/opennutritracker/). If you would rather work in the repository directly, the source strings live in [`lib/l10n/intl_en.arb`](lib/l10n/intl_en.arb). See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions.

## What people say

> This app has a user-friendly interface and is unburdened by the ridiculous (and constant) cash-grabbing that is chronic across health and wellness apps. As someone suffering from extreme subscription fatigue — I'm not a walking wallet! — this nutrition tracker is a breath of fresh air.

— **Ai C.**, Google Play ★★★★★

> No ads, no paywalls, no bloat, no bs. You can export your data at any moment, or import some from somewhere else, no questions asked. I have experienced no bugs in these last few months. Developers are still active on the repo, so I'm expecting it to get even better.

— **App Store review** ★★★★★

> The most recent version puts this open source nutrition tracker among the best resources out there — all while respecting your privacy through free and open source software. If you care about your fitness and care about having control of your data, look no further!

— **App Store review** ★★★★★

> Excellent simple app without ads that gets the job done. I have legit lost over 10 kg using this app.

— **Esko E.**, Google Play ★★★★★

> Simple, fast and very functional. Finally I don't have to sell my soul to MyFitnessPal ;)

— **Frederic-Leon C.**, Google Play ★★★★★

Reviews are lightly trimmed for length; the full text is on the [App Store](https://apps.apple.com/us/app/opennutritracker/id6451490901) and [Google Play](https://play.google.com/store/apps/details?id=com.opennutritracker.ont.opennutritracker) listings. Bug reports and feature requests belong in the [issue tracker](https://github.com/simonoppowa/OpenNutriTracker/issues), which gets read faster than a review does.

## Mentions

> I've got my OpenNutriTracker here, my open-source calorie counter. Support open-source apps. No ads, no subscriptions, and I don't send my data to anyone — everything stays here.

— [**Cadê a Chave?**, Ep. 1773](https://www.youtube.com/watch?v=DPLtsx-f6Ro&t=498s) (at 8:18), the vlog channel run by the team behind [Coisa de Nerd](https://www.youtube.com/@coisadenerd), one of Brazil's largest tech channels at 11M+ subscribers. Translated from the Portuguese by a contributor in [#375](https://github.com/simonoppowa/OpenNutriTracker/issues/375).

| Where | What |
| :-- | :-- |
| [Trendshift](https://trendshift.io/repositories/12625) | Ranked #2 Dart Repository of the Day |
| [It's All Widgets!](https://itsallwidgets.com/opennutritracker) | Featured in the Flutter app showcase |
| [AlternativeTo](https://alternativeto.net/software/myfitnesspal/?license=opensource) | Currently the top-ranked open-source MyFitnessPal alternative |

If you have written or talked about OpenNutriTracker somewhere, open an issue or a pull request and it can go on this list.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project's conventions, including the requirement to target the `develop` branch and the steps for adding localized strings.

Built with Flutter and Dart, following a clean-architecture split (data / domain / presentation) with `flutter_bloc` for state, `get_it` for dependency injection, and encrypted `hive_ce` boxes for local storage. [AGENTS.md](AGENTS.md) is the full architecture and conventions reference.

**Getting started:** see [GettingStarted.md](GettingStarted.md) for setting up a local build.

**Data export format:** the export bundle (Settings → Export / Import App Data → Export) is documented at [`docs/export-format.md`](docs/export-format.md), covering both the JSON schema and the CSV companion the import / export round-trip uses.

**Food database backend:** the multi-source food database lives in its own repository, [OpenNutriTracker-Backend](https://github.com/simonoppowa/OpenNutriTracker-Backend), which holds the schema, import pipeline, and translation tooling. Self-hosting it and pointing a local build at your own Supabase project is documented at [`docs/supabase-self-hosting.md`](docs/supabase-self-hosting.md).

Thanks to all the contributors:

<a href="https://github.com/simonoppowa/OpenNutriTracker/graphs/contributors">
<img src="https://contrib.rocks/image?repo=simonoppowa/OpenNutriTracker" />
</a>

## Disclaimer

> [!WARNING]
> OpenNutriTracker is not a medical application. All data provided is not validated and
> should be used with caution. Please maintain a healthy lifestyle and consult a
> professional if you have any problems. Use during illness, pregnancy or lactation is
> not recommended.

> [!NOTE]
> The application is still under construction. Errors, bugs and crashes might occur.

## Acknowledgments

The food database used in OpenNutriTracker is powered by [Open Food Facts](https://world.openfoodfacts.org/) together with a multi-source reference backend hosted in Supabase: [USDA FoodData Central](https://fdc.nal.usda.gov/) (CC0) and the [Bundeslebensmittelschlüssel](https://www.blsdb.de) 4.0 (CC BY 4.0, © Max Rubner-Institut), with the [Anuvaad INDB](https://anuvaad.org.in) (CC BY 4.0) and [TBCA Brazil](https://www.tbca.net.br) (USP/FoRC) prepared as future sources. The schema and import pipeline live in the [OpenNutriTracker-Backend](https://github.com/simonoppowa/OpenNutriTracker-Backend) repository; self-hosting is documented in [`docs/supabase-self-hosting.md`](docs/supabase-self-hosting.md).

Dietary Reference Intake values for the micronutrient panel come from the U.S. National Academies' Institute of Medicine tables. The in-app Sources & References screen (one tap from the home calorie ring or the profile BMI card) lists the peer-reviewed sources used for energy needs, BMI classification, macro distribution, MET activity calories, and non-binary calorie estimation.

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for more information.

## Contact

For questions, suggestions, or collaborations, contact the maintainer:

**Simon Oppowa**

- GitHub: [@simonoppowa](https://github.com/simonoppowa)
- Email: [opennutritracker-dev@pm.me](mailto:opennutritracker-dev@pm.me)


next

<div align="center">
  <img src="https://raw.githubusercontent.com/parthbuilds-community/FitMart/main/client/public/logo.png" alt="FitMart" width="100"/>

# FitMart

### *Your All-in-One Fitness & Nutrition E-Commerce Platform*

> A full-stack MERN e-commerce application combining premium fitness gear, nutrition products, workout tracking, and seamless payments — built for learning, collaboration, and real-world use.

<br/>

[![React](https://img.shields.io/badge/React-v19-61DAFB?style=flat-square&logo=react)](https://reactjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-v16+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?style=flat-square&logo=mongodb)](https://www.mongodb.com/)
[![Firebase](https://img.shields.io/badge/Firebase-Auth-FFCA28?style=flat-square&logo=firebase)](https://firebase.google.com/)
[![Razorpay](https://img.shields.io/badge/Razorpay-Payments-0C2A5E?style=flat-square)](https://razorpay.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38B2AC?style=flat-square&logo=tailwind-css)](https://tailwindcss.com/)
[![Gemini AI](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?style=flat-square&logo=google)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Active%20Development-orange?style=flat-square)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=flat-square)](docs/CONTRIBUTING.md)

<br/>

[![GitHub Stars](https://img.shields.io/github/stars/parthbuilds-community/FitMart?style=for-the-badge&logo=github)](https://github.com/parthbuilds-community/FitMart/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/parthbuilds-community/FitMart?style=for-the-badge&logo=github)](https://github.com/parthbuilds-community/FitMart/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/parthbuilds-community/FitMart?style=for-the-badge&logo=github)](https://github.com/parthbuilds-community/FitMart/issues)
[![GitHub PRs](https://img.shields.io/github/issues-pr/parthbuilds-community/FitMart?style=for-the-badge&logo=github)](https://github.com/parthbuilds-community/FitMart/pulls)

</div>

---

## 📌 Table of Contents

- [About the Project](#-about-the-project)
- [Live Demo](#-live-demo)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Pages & Routes](#-pages--routes)
- [Components](#-components)
- [Quick Start](#-quick-start)
- [Environment Variables](#-environment-variables)
- [Seeding the Database](#-seeding-the-database)
- [Running the App](#️-running-the-app)
- [API Reference](#-api-reference)
- [Data Models](#-data-models)
- [Design System](#-design-system)
- [Admin Panel](#-admin-panel)
- [Notes & Recommendations](#-notes--recommendations)
- [Contributing](#-contributing)
- [Contributors](#-contributors)
- [License](#-license)

---

## 🧠 About the Project

**FitMart** is a full-stack e-commerce web application built with the MERN stack. It's designed as both a **learning resource** and a **real-world starting point** for building modern storefronts.

The project covers end-to-end functionality including:

- 🔐 User authentication via Firebase (Email/Password + Google Sign-In)
- 🛒 Cart management with real-time stock reservation logic
- 💳 Secure payments via Razorpay (with HMAC signature verification)
- 📦 Order management with price snapshotting at purchase time
- 🤖 AI-powered Fitness Chatbot powered by **Google Gemini 2.5 Flash**
- 🧮 BMI & TDEE Calculator with personalized product recommendations
- 🔥 Calorie Calculator for weight loss and muscle gain targets
- 🏋️ Workout Tracker with a FullCalendar-based fitness calendar
- 📓 Workout Notes with exercise logging and GIF previews (via ExerciseDB API)
- 📍 Nearby Fitness Centers discovery based on user's saved address
- 👤 User Profile with editable addresses and shipping management
- 🐛 In-app Bug Reporting system accessible to all users
- 📧 Automated transactional emails (first purchase welcome, inactivity re-engagement)
- 👑 Full Admin Panel with dashboard, inventory, reports, marketing strategies, customer management, and bug tracker
- 🎯 Welcome discount system for first-time buyers
- 🏆 Rewards system for loyal customers
- 🔧 GitHub integration for project transparency
- 🛡️ Rate limiting, Helmet security headers, and request logging middleware

Whether you're a beginner learning full-stack development or an experienced developer looking to contribute — **FitMart is built for you.**

---

## 🌐 Live Demo

<p align="center">
  <a href="https://fitmart-omega.vercel.app/" target="_blank">
    <img src="https://img.shields.io/badge/Launch%20FitMart-Live%20Now-black?style=for-the-badge" alt="Launch FitMart Live Demo" />
  </a>
</p>

🔗 https://fitmart-omega.vercel.app/

> 💡 Try exploring products, the workout tracker, the AI chatbot, and the admin panel for the full experience.

---

## ✨ Features

### Customer-Facing

| Feature | Description |
|---|---|
| 🛍️ Product Catalog | Browse products with images, pricing, badges & category filters |
| 🔍 Search | Real-time product search by name and brand |
| 🛒 Smart Cart | Cart with quantity controls and real-time stock reservation |
| 📦 Order Management | Orders with price snapshotting at time of purchase |
| 💳 Razorpay Payments | Secure order creation & HMAC payment verification |
| 🔐 Firebase Auth | Email/password and Google Sign-In |
| 🎁 Welcome Discount | 10% off automatically applied for first-time buyers |
| 🤖 Fitness Chatbot | AI-powered assistant (Gemini 2.5 Flash) for workout and nutrition queries |
| 🧮 BMI Calculator | Body metrics tool with TDEE calculation and product recommendations |
| 🔥 Calorie Calculator | Weight loss and weight gain daily calorie targets |
| 🏋️ Workout Tracker | FullCalendar-based fitness calendar to plan and visualize sessions |
| 📓 Workout Notes | Log exercises per session with animated GIFs from ExerciseDB |
| 📍 Nearby Fitness Centers | Discover gyms, yoga studios, and fitness centers near you |
| 👤 User Profile | Manage personal info, shipping addresses, and default address |
| 🏋️ Fitness Plans | Weight Loss, Muscle Building, and Mobility & Recovery plans |
| 🐛 Bug Reporter | In-app bug reporting widget available to all signed-in users |
| 📧 Welcome Email | Automated first-purchase congratulations email |
| 🏆 Rewards System | Earn points for purchases, reviews, and referrals; redeem for discounts |
| 🔧 GitHub Integration | View project statistics and contribution metrics |
| 📱 PWA Ready | Progressive Web App support for mobile installation |

### Admin-Facing

| Feature | Description |
|---|---|
| 📊 Dashboard | Revenue KPIs, charts, top products, and recent orders |
| 📦 Inventory | Real-time stock levels, low-stock alerts, and product filtering |
| 👥 Customers | Customer directory with segments (new / returning / high-value) |
| 🔍 Customer Detail | Full order history and spend analytics per customer |
| 📈 Reports | Sales reports with daily, weekly, and monthly breakdowns |
| 📣 Marketing | Curated digital marketing strategies tailored to FitMart |
| 🐛 Bug Tracker | View, manage, and update status of all user-submitted bug reports |

---

## 🛠️ Tech Stack

### Frontend

| Technology | Purpose |
|---|---|
| **React v19** + **Vite** | UI framework with fast HMR dev experience |
| **Tailwind CSS v4** | Utility-first styling |
| **React Router v7** | Client-side routing |
| **Firebase (client)** | Authentication |
| **Recharts** | Admin dashboard charts (AreaChart, BarChart) |
| **Framer Motion** | Smooth animations & transitions |
| **FullCalendar** | Interactive workout calendar (`@fullcalendar/react`) |

### Backend

| Technology | Purpose |
|---|---|
| **Node.js** + **Express** | REST API server |
| **Mongoose** | MongoDB ODM |
| **Firebase Admin SDK** | Server-side auth token verification |
| **Razorpay SDK** | Payment order creation and HMAC verification |
| **Nodemailer** | Transactional email delivery via SMTP |
| **Helmet** | HTTP security headers |
| **express-rate-limit** | API and payment endpoint rate limiting |
| **Google Gemini 2.5 Flash** | AI chatbot via `@google/generative-ai` |

### Database & Services

| Service | Usage |
|---|---|
| **MongoDB** (Atlas or local) | Primary database |
| **Firebase** | Authentication provider |
| **Razorpay** | Payment processing |
| **ExerciseDB (RapidAPI)** | Exercise library with animated GIFs |
| **SMTP Provider** | Transactional email (Gmail or any SMTP service) |

---

## 📁 Project Structure

```
FitMart/
├── client/                        # React + Vite Frontend
│   ├── public/                    # Static assets (logo, icons)
│   ├── src/
│   │   ├── auth/
│   │   │   ├── firebase.js        # Firebase app initialization
│   │   │   ├── useAuth.js         # Auth state hook
│   │   │   └── useWelcomeDiscount.js  # First-order discount hook
│   │   ├── components/
│   │   │   ├── AdminNavbar.jsx    # Admin panel navigation bar
│   │   │   ├── AdminRoute.jsx     # Admin-only route guard
│   │   │   ├── AddressSelector.jsx  # Address selection widget
│   │   │   ├── AdminKPIGrid.jsx   # Admin KPI grid component
│   │   │   ├── BMICalculator.jsx  # BMI/TDEE calculator widget
│   │   │   ├── BugScreenshot.jsx  # Bug screenshot display
│   │   │   ├── CalorieCalculator.jsx  # Daily calorie target calculator
│   │   │   ├── CartDrawer.jsx     # Slide-in cart panel
│   │   │   ├── CategoryPillsSkeleton.jsx  # Category pills skeleton loader
│   │   │   ├── DevAdminLogin.jsx  # Development admin login
│   │   │   ├── ErrorBoundary.jsx  # Global error boundary
│   │   │   ├── FitnessCenterDetail.jsx  # Fitness center detail modal
│   │   │   ├── FitnessChatBot.jsx # Floating AI chatbot (Gemini)
│   │   │   ├── Navbar.jsx         # Main navigation bar
│   │   │   ├── NearbyFitnessCenters.jsx  # Nearby gym/studio discovery
│   │   │   ├── NonAdminRoute.jsx  # Redirects admin away from customer pages
│   │   │   ├── ProductCardSkeleton.jsx  # Product card skeleton loader
│   │   │   ├── ReportBugButton.jsx  # Floating bug report widget
│   │   │   ├── SkeletonItem.jsx   # Skeleton item loader
│   │   │   ├── SkeletonSummary.jsx  # Skeleton summary loader
│   │   │   ├── Stars.jsx          # Star rating component
│   │   │   ├── Toast.jsx          # Toast notification component
│   │   │   ├── WelcomeBanner.jsx  # First-visit discount banner
│   │   │   └── WorkoutCalendar.jsx  # FullCalendar workout calendar
│   │   ├── hooks/
│   │   │   └── useInfiniteProducts.js  # Infinite product query hook
│   │   │   └── useGithubStats.js       # GitHub statistics hook
│   │   ├── pages/
│   │   │   ├── AdminBugs.jsx              # Admin bug tracker
│   │   │   ├── AdminCustomerDetail.jsx
│   │   │   ├── AdminCustomers.jsx
│   │   │   ├── AdminDashboard.jsx
│   │   │   ├── AdminInventory.jsx
│   │   │   ├── AdminMarketing.jsx         # Marketing strategy panel
│   │   │   ├── AdminReports.jsx
│   │   │   ├── Authentication.jsx
│   │   │   ├── Checkout.jsx
│   │   │   ├── ExercisePage.jsx           # Browse exercises by muscle group
│   │   │   ├── HomePage.jsx
│   │   │   ├── LandingPage.jsx
│   │   │   ├── LegalPrivacy.jsx          # Privacy policy page
│   │   │   ├── LegalTerms.jsx            # Terms of service page
│   │   │   ├── MobilityRecoveryPlans.jsx
│   │   │   ├── MuscleBuildingPlans.jsx
│   │   │   ├── NotFound.jsx
│   │   │   ├── NotesPage.jsx              # Workout logging / notes
│   │   │   ├── PaymentPage.jsx
│   │   │   ├── ProductConfirmation.jsx
│   │   │   ├── ProductPage.jsx
│   │   │   ├── Profile.jsx                # User profile & addresses
│   │   │   ├── TrackerPage.jsx            # Workout tracker (calendar view)
│   │   │   └── WeightLossPlans.jsx
│   │   ├── utils/
│   │   │   ├── api/
│   │   │   │   └── bugs.js        # Bug API utilities
│   │   │   ├── formatters.js       # Currency formatter (INR)
│   │   │   ├── getAuthHeaders.js   # Firebase token → Authorization header
│   │   │   ├── healthUtils.js      # BMI, BMR, TDEE, calorie calculations
│   │   │   ├── normalizeProduct.js # Normalizes productId/id field across responses
│   │   │   ├── rewardsUtils.js     # Rewards utilities
│   │   │   └── workoutStorage.js   # LocalStorage helpers for workout data
│   │   ├── App.jsx                # Root router
│   │   ├── index.css              # Tailwind import
│   │   └── main.jsx               # React entry point
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
└── server/                        # Node.js + Express Backend
    ├── middleware/
    │   ├── logger.js              # Colored request/response logger
    │   ├── ownership.js         # Resource ownership middleware
    │   ├── validateRequest.js   # Request validation middleware
    │   ├── verifyAdmin.js         # Admin UID authorization middleware
    │   └── verifyFirebaseToken.js # Firebase Bearer token middleware
    ├── models/
    │   ├── Bug.js                 # Bug report schema
    │   ├── Cart.js                # Cart schema
    │   ├── FitnessCenter.js       # Fitness center schema
    │   ├── Order.js               # Order schema
    │   ├── Product.js             # Product schema
    │   ├── Rewards.js             # Rewards schema
    │   ├── UserProfile.js         # Extended user profile schema
    │   └── WorkoutLog.js          # Workout log schema
    ├── routes/
    │   ├── bugs.js                # Bug reporting & admin management
    │   ├── cart.js                # Cart management + stock reservation
    │   ├── chat.js                # Gemini AI chatbot endpoint
    │   ├── customers.js           # Customer management
    │   ├── dashboard.js           # Admin dashboard data
    │   ├── devAuth.js             # Development authentication endpoints
    │   ├── exercises.js           # ExerciseDB proxy (RapidAPI)
    │   │   ├── fitnessCenters.js      # Nearby fitness center discovery
    │   ├── github.js              # GitHub integration endpoints
    │   ├── orders.js              # Order creation and retrieval
    │   ├── payment.js             # Razorpay integration
    │   ├── products.js            # CRUD for products
    │   ├── reports.js             # Sales reports
    │   ├── rewards.js             # Rewards endpoints
    │   ├── user.js                # Profile, discount, address management
    │   └── workouts.js            # Workout tracking endpoints
    ├── services/
    │   ├── emailService.js              # Nodemailer SMTP transporter
    │   │   ├── emailTemplates.js            # HTML/text email templates
    │   ├── firstPurchaseEmailService.js # First-purchase welcome email logic
    │   │   ├── inactiveCustomerEmailService.js  # Re-engagement email service
    │   │   └── orderService.js              # Order processing service
    ├── db.js                      # MongoDB connection
    │   ├── firebaseAdmin.js           # Firebase Admin SDK setup
    ├── index.js                   # Server entry point
    ├── seed.js                    # Product DB seed script
    └── seedFitnessCenters.js      # Fitness center DB seed script
```

---

## 🗺️ Pages & Routes

### Public / Customer Routes

| Route | Page | Description |
|---|---|---|
| `/` | `LandingPage` | Marketing homepage with hero, categories, plans, testimonials |
| `/auth` | `Authentication` | Sign In, Sign Up, and Password Reset |
| `/home` | `HomePage` | Product catalog with search, cart, BMI/calorie calculators, plans |
| `/product/:productId` | `ProductPage` | Individual product detail page |
| `/checkout` | `Checkout` | Order review with discount summary |
| `/payment` | `PaymentPage` | Razorpay payment flow + demo bypass |
| `/payment-confirmation` | `ProductConfirmation` | Post-payment success screen |
| `/profile` | `Profile` | User profile, name, phone, saved addresses |
| `/tracker` | `WorkoutTracker` | FullCalendar fitness calendar for planning sessions |
| `/notes` | `NotesPage` | Log workout details and add exercises for a chosen date |
| `/exercises` | `ExercisePage` | Browse exercises by muscle group with animated GIFs |
| `/plans/weight-loss` | `WeightLossPlans` | Weight loss program listing |
| `/plans/muscle-building` | `MuscleBuildingPlans` | Muscle building program listing |
| `/plans/mobility-recovery` | `MobilityRecoveryPlans` | Mobility & recovery program listing |
| `*` | `NotFound` | 404 fallback |

> **Note:** Privacy Policy and Terms & Conditions pages are also included and linked from the app footer.

### Admin Routes (guarded — admin UID only)

| Route | Page | Description |
|---|---|---|
| `/admin/dashboard` | `AdminDashboard` | KPIs, revenue chart, top products, recent orders |
| `/admin/inventory` | `AdminInventory` | Stock levels with low-stock alerts |
| `/admin/customers` | `AdminCustomers` | All customers with segment tagging |
| `/admin/customers/:userId` | `AdminCustomerDetail` | Customer profile + full order history |
| `/admin/reports` | `AdminReports` | Sales reports (daily / weekly / monthly) |
| `/admin/marketing` | `AdminMarketing` | Curated digital marketing strategy cards |
| `/admin/bugs` | `AdminBugs` | View and manage user-submitted bug reports |

> **Route Guards:** `AdminRoute` redirects non-admins to `/home`. `NonAdminRoute` redirects the admin account to `/admin/dashboard`.

---

## 🧩 Components

### `Navbar`

Dual-variant navigation bar (`landing` / `home`). Landing variant is transparent and becomes opaque on scroll. Home variant is sticky with search, cart icon (with badge), user avatar dropdown, and links to Profile, Workout Tracker, and Exercises.

### `CartDrawer`

Slide-in panel from the right showing cart items with quantity controls, remove buttons, subtotal, and a checkout CTA. Closes on `Escape` key or overlay click. Locks body scroll when open.

### `FitnessChatBot`

Floating chat widget (FAB in bottom-right corner) backed by the `/api/chat` endpoint powered by **Google Gemini 2.5 Flash**. Supports markdown-style bold text rendering, typing indicator, and auto-scroll. Full-screen on mobile. Falls back to curated static responses when the API is unavailable.

### `BMICalculator`

Form-based calculator that computes BMI and TDEE from user inputs (weight, height, age, gender, activity level). Displays results with a product category recommendation that links to the store.

### `CalorieCalculator`

Computes daily calorie targets for weight loss and muscle gain using the Mifflin-St Jeor BMR formula. Displays maintenance, weight loss (−500 kcal), and weight gain (+500 kcal) targets side by side.

### `WorkoutCalendar`

Interactive fitness calendar built on **FullCalendar** (`@fullcalendar/react`). Displays logged workout sessions as calendar events. Clicking a date navigates to the Notes page for that day.

### `NearbyFitnessCenters`

Fetches gyms, yoga studios, pilates studios, and fitness centers from the backend and displays them ranked by proximity to the user's saved address. Clicking a card opens a detail modal.

### `ReportBugButton`

Floating bug report widget visible to authenticated users. Opens a modal form that posts directly to `/api/bugs`. Automatically attaches the user's name, email, and current page URL.

### `WelcomeBanner`

Top-of-page animated banner shown to first-time users. Displays the 10% welcome discount and dismisses via a POST to `/api/user/dismiss-banner`.

### `AdminNavbar`

Admin-specific sticky navbar with range selector buttons (Today / Week / Month), brand link, navigation to all admin pages, and user avatar dropdown with sign out.

### `AdminRoute` / `NonAdminRoute`

React Router route guards using `useAuth` and `VITE_ADMIN_UID` to protect admin and customer routes respectively.

---

## 🚀 Quick Start

### Prerequisites

Make sure you have the following installed:

- [Node.js](https://nodejs.org/) v16+
- [Redis](https://redis.io/) (optional) — for product API caching
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
- A [MongoDB](https://www.mongodb.com/atlas) connection (Atlas or local)
- A [Firebase](https://firebase.google.com/) project (for auth)
- A [Razorpay](https://razorpay.com/) account (for payments)
- A [Google Gemini API key](https://ai.google.dev/) (for the AI chatbot)
- A [RapidAPI](https://rapidapi.com/justin-thewebdev/api/exercisedb) account with ExerciseDB access (for the exercises feature)
- An SMTP provider (e.g., Gmail) for transactional emails *(optional)*

---

### 🐳 Running the Full Stack with Docker

The included `docker-compose.yml` runs all three services — **MongoDB**, the **Node/Express API**, and the **React client** (served by Nginx) — with a single command.

#### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

#### Setup

1. Copy the server env file and fill in your values:

```bash
cp server/.env.example server/.env
```

> ⚠️ **Never commit `server/.env` or `serviceAccountKey.json` to git.** They are already in `.gitignore`.

2. Export your Vite/Firebase client credentials so Docker can bake them into the React build. The easiest way is a `.env` file in the project root:

```env
VITE_FIREBASE_API_KEY=your_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_RAZORPAY_KEY_ID=your_razorpay_key
VITE_ADMIN_UID=your_firebase_admin_uid
```

3. Build and start all services:

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| React client | http://localhost |
| Node API | http://localhost:5000 |
| MongoDB | mongodb://localhost:27017 |

#### Service startup order

`mongodb` → (healthcheck passes) → `server` → (healthcheck passes) → `client`

This guarantees the API never starts before the database is ready.

#### Stopping

```bash
docker compose down          # stop containers
docker compose down -v       # stop + delete the MongoDB volume
```

---

### 1. Clone the Repository

```bash
git clone https://github.com/parthbuilds-community/FitMart.git
cd FitMart
```

### 2. Set Up the Server

```bash
cd server
npm install
```

Create a `.env` file in the `server/` folder (see [Environment Variables](#-environment-variables) below):

```bash
cp .env.example .env   # if available, or create manually
```

Seed the database with sample products:

```bash
npm run seed
```

Optionally seed fitness center data:

```bash
npm run seed:fitness
```

Start the backend dev server:

```bash
npm run dev
```

> The server runs at **http://localhost:5000** by default.

---

### 3. Set Up the Client

Open a **new terminal** and run:

```bash
cd client
npm install
npm run dev
```

> The client runs at **http://localhost:5173** by default.

---

## 🔑 Environment Variables

> ⚠️ **Never commit your `.env` files or API secrets to GitHub!** They are already in `.gitignore`.

### Server — `server/.env`

```env
# =========================================
# Server Configuration
# =========================================
NODE_ENV=development
PORT=5000

ALLOWED_ORIGIN=http://localhost:5173
APP_BASE_URL=http://localhost:5173


# =========================================
# MongoDB Configuration
# =========================================
# For local development with Docker, use: mongodb://localhost:27017
# For MongoDB Atlas, use your connection string
MONGO_URI=mongodb://localhost:27017
MONGO_DB=FitMart

# =========================================
# DNS Configuration 
# =========================================
DNS_SERVERS=8.8.8.8,8.8.4.4


# =========================================
# Admin Configuration
# =========================================
ADMIN_UID=your_admin_uid
SUPER_ADMIN_UID=your_super_admin_uid
VITE_ADMIN_UID=your_admin_uid
VITE_SUPER_ADMIN_UID=your_super_admin_uid

# Local development admin (do NOT use production credentials here)
# Example:
# DEV_ADMIN_EMAIL=admin@example.com
# DEV_ADMIN_UID=dev-admin-uid


# =========================================
# Cloudinary Configuration
# Used for bug screenshot/image uploads
# =========================================
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret


# =========================================
# Razorpay Configuration
# =========================================
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret


# =========================================
# Gemini AI Configuration
# =========================================
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL_NAME=gemini-2.5-flash


# =========================================
# Firebase Admin SDK
# =========================================
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"


# =========================================
# RapidAPI Configuration (ExerciseDB)
# =========================================
RAPIDAPI_KEY=your_rapidapi_key
RAPIDAPI_HOST=exercisedb.p.rapidapi.com


# =========================================
# SMTP Configuration (Email Service)
# =========================================
SMTP_HOST=your_smtp_host
SMTP_PORT=587
SMTP_SECURE=false

SMTP_USER=your_smtp_email
SMTP_PASS=your_smtp_password

SMTP_FROM=noreply@fitmart.com
APP_BASE_URL=http://localhost:5173
```

> **Startup behaviour:** The server validates environment variables on startup. `MONGO_URI` is the only truly critical variable — the server will exit if it's missing. All other variables are optional; missing ones produce a warning and disable the corresponding feature gracefully.

#### Getting Firebase Admin Credentials

1. Go to [Firebase Console](https://console.firebase.google.com) → **Project Settings** → **Service Accounts**
2. Select **Node.js** and click **"Generate new private key"**
3. A `.json` file downloads — copy these values:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (wrap in double quotes, keep all `\n`)
4. **Delete the `.json` file** — never commit it to GitHub

#### Getting a Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/)
2. Sign in and click **"Get API key"**
3. Copy the key and add it as `GEMINI_API_KEY`

#### Getting a RapidAPI Key (ExerciseDB)

1. Create a free account at [RapidAPI](https://rapidapi.com/)
2. Subscribe to the [ExerciseDB API](https://rapidapi.com/justin-thewebdev/api/exercisedb) (free tier available)
3. Copy your `X-RapidAPI-Key` and set it as `RAPIDAPI_KEY`

#### MongoDB Atlas SRV lookup fails with `querySrv ECONNREFUSED`

On some Windows environments, Node.js may incorrectly use a local DNS resolver, causing MongoDB Atlas SRV lookups to fail.

If you encounter:

```text
querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
```

set a custom DNS server in your `.env`:

```env
DNS_SERVERS=8.8.8.8,8.8.4.4
```

or

```env
DNS_SERVERS=1.1.1.1,1.0.0.1
```

Restart the server after updating the environment variable.

#### Setting Up Transactional Email (Optional)

See [`docs/FIRST_PURCHASE_EMAIL_SETUP.md`](docs/FIRST_PURCHASE_EMAIL_SETUP.md) for full instructions, including Gmail app password setup.

### Client — `client/.env`

```env
VITE_API_URL=http://localhost:5000
VITE_RAZORPAY_KEY_ID=<your_razorpay_key_id>
VITE_ADMIN_UID=<firebase_uid_of_admin_account>

# Firebase config (from Firebase Console → Project Settings → General)
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MEASUREMENT_ID=
```

> **Setting the Admin UID:** Sign in to Firebase, find your user's UID in the Firebase Console under **Authentication → Users**, and paste it into `VITE_ADMIN_UID`. That account will be redirected to `/admin/dashboard` on login.

---

## 🌱 Seeding the Database

### Products

The seed script populates your MongoDB with sample fitness products across all categories (Equipment, Nutrition, Wearables):

```bash
cd server
npm run seed
```

Each seeded product includes: `productId`, `name`, `brand`, `category`, `price`, `originalPrice`, `rating`, `reviews`, `badge`, `image`, `stock`, and `reserved`.

### Fitness Centers

A separate seed script populates the `FitnessCenter` collection with sample gyms, yoga studios, pilates studios, and fitness centers:

```bash
cd server
npm run seed:fitness
```

---

## ▶️ Running the App

### Development

```bash
# Terminal 1 — Backend
cd server && npm run dev

# Terminal 2 — Frontend
cd client && npm run dev
```

### Production

```bash
# Build the frontend
cd client && npm run build

# Start the server (serves API; deploy frontend dist/ separately)
cd server && npm start
```

> **Tip:** The client is pre-configured for Vercel deployment (`client/vercel.json` is included). The server can be deployed to Railway, Render, or any Node.js host.

---

## 📡 API Reference

**Base URL:** `http://localhost:5000` (or your `VITE_API_URL`)

> All authenticated endpoints require an `Authorization: Bearer <firebase_id_token>` header.

**API response contract:** Errors return `{ "success": false, "error": "<message>" }`. Success responses are `{ "success": true, ...data }` (the payload shape is per-endpoint). New endpoints use the `ok()`/`fail()` helpers in `server/utils/apiResponse.js`; legacy routes are being migrated incrementally.

### 🛍️ Products

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/products` | — | Paginated product listing with filtering/sorting/search and optional field projection. Supports `page`, `limit`, `category`, `search`, `sort`, `fields`. Use `?all=true` for legacy full-list behavior (avoid in production). See `docs/PRODUCTS_API.md` for full details. |
| `GET` | `/api/products/:id` | — | Get product by `productId` |
| `POST` | `/api/products` | ✅ Admin | Create a new product (invalidates products cache) |
| `PUT` | `/api/products/:id` | ✅ Admin | Update product by `productId` (invalidates products cache) |
| `DELETE` | `/api/products/:id` | ✅ Admin | Delete product by `productId` (invalidates products cache) |

### Pagination & Caching

- **Paginated endpoint:** `/api/products` now returns paginated results and supports filtering, sorting, search, and field projection. Query params: `page`, `limit`, `category`, `search`, `sort`, `fields`. For full details and examples see [docs/PRODUCTS_API.md](docs/PRODUCTS_API.md).
- **Backward compatibility:** `?all=true` retains the old behavior of returning all products; avoid in production.
- **Caching:** Server supports optional Redis caching for product-list queries. Configure with `REDIS_URL` or `REDIS_HOST`. TTL is controlled by `PRODUCTS_CACHE_TTL` (seconds, default 60). Cache is invalidated on product create/update/delete and after seeding.

### Frontend — React Query

- The client integrates `@tanstack/react-query` for product list fetching and caching. The homepage uses an infinite scroll / "See More" pattern powered by `useInfiniteQuery`. See `client/src/hooks/useInfiniteProducts.js`.

### Tests

- **Server unit tests:** `cd server && npm test` (Jest + Supertest). Tests mock external services (Firebase, Redis) and verify pagination metadata, cache behavior, and conditional `ETag` handling.
- **E2E (planned):** Playwright/Cypress tests should validate infinite loading, `JSON-LD` structured data presence, and the "See More" flow.

### 🛒 Cart

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/cart/:userId` | — | Get or create a user's cart |
| `POST` | `/api/cart/:userId/add` | — | Add item — body: `{ productId, quantity }` |
| `POST` | `/api/cart/:userId/remove` | — | Remove item — body: `{ productId, quantity }` |
| `DELETE` | `/api/cart/:userId` | — | Clear cart and release reserved stock |

### 📦 Orders

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | — | Create order — body: `{ userId, items? }` |
| `GET` | `/api/orders/:userId` | — | List all orders for a user |

### 💳 Payments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/payment/create-order` | — | Create a Razorpay order |
| `POST` | `/api/payment/verify-payment` | — | Verify HMAC signature + trigger first-purchase email |
| `POST` | `/api/payment/clear-cart` | — | Release stock & clear cart — body: `{ userId }` |
| `POST` | `/api/payment/demo-success` | — | Simulate successful payment (testing only) |

> **Security:** Payment verification uses HMAC-SHA256 on `razorpay_order_id|razorpay_payment_id` with `RAZORPAY_KEY_SECRET`. Never expose this key to the client.

### 🤖 Chat

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/chat` | — | Send a message — body: `{ message }` — returns `{ reply }` (powered by Gemini 2.5 Flash) |

### 👤 User

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/user/login` | — | Register login, sync Firebase email, check welcome discount |
| `GET` | `/api/user/discount-status/:userId` | — | Get discount eligibility and percent |
| `POST` | `/api/user/use-discount` | — | Mark welcome discount as used |
| `POST` | `/api/user/dismiss-banner` | — | Dismiss the welcome banner |
| `GET` | `/api/user/profile/:userId` | ✅ | Get user profile (name, phone, addresses) |
| `PUT` | `/api/user/profile/:userId` | ✅ | Update user profile |
| `POST` | `/api/user/profile/:userId/addresses` | ✅ | Add a shipping address |
| `PUT` | `/api/user/profile/:userId/addresses/:addressId` | ✅ | Update a shipping address |
| `DELETE` | `/api/user/profile/:userId/addresses/:addressId` | ✅ | Delete a shipping address |
| `PUT` | `/api/user/profile/:userId/default-address` | ✅ | Set default shipping address |

### 🏋️ Exercises

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/exercises?category=<name>` | — | Fetch exercises by muscle group from ExerciseDB |

Supported `category` values: `chest`, `back`, `shoulders`, `cardio`, `abs`, `arms`, `legs`

### 📍 Fitness Centers

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/fitness-centers/nearby` | ✅ | Get fitness centers ranked by proximity to user's address |
| `GET` | `/api/fitness-centers/nearby?type=<type>` | ✅ | Filter by type: `gym`, `yoga`, `pilates`, `fitness_studio` |

### 🐛 Bugs

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/bugs` | — | Submit a bug report (auth optional; enriches reporter info if token present) |
| `GET` | `/api/bugs` | ✅ Admin | List all bug reports |
| `PATCH` | `/api/bugs/:id/status` | ✅ Admin | Update bug status: `open`, `in-progress`, `resolved` |

### 📊 Admin

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/dashboard?range=today\|week\|month` | ✅ Admin | Dashboard KPIs, charts, recent orders |
| `GET` | `/api/reports/sales?range=daily\|weekly\|monthly` | ✅ Admin | Sales summary + revenue by date + product performance |
| `GET` | `/api/customers` | ✅ Admin | All customers with order counts, spend, and segment |
| `GET` | `/api/customers/:userId` | ✅ Admin | Single customer profile + order history |

### 🏆 Rewards

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/rewards` | — | Get rewards program details and user's rewards points |
| `POST` | `/api/rewards/earn` | — | Earn rewards points for an action |
| `POST` | `/api/rewards/redeem` | — | Redeem rewards points for discounts or products |

### 🔧 Github

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/github/stats` | — | Get GitHub repository statistics (stars, forks, etc.) |

### 🏋️‍♂️ Workouts

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/workouts` | — | Get user's workout logs |
| `POST` | `/api/workouts` | — | Create a new workout log |
| `GET` | `/api/workouts/:id` | — | Get a specific workout log |
| `PUT` | `/api/workouts/:id` | ✅ | Update a workout log |
| `DELETE` | `/api/workouts/:id` | ✅ | Delete a workout log |

---

## 🗃️ Data Models

### Product

```js
{
  productId:     Number  (unique, required),
  name:          String,
  brand:         String,
  category:      String,   // "Equipment" | "Nutrition" | "Wearables"
  price:         Number  (required),
  originalPrice: Number,
  rating:        Number,   // 0–5
  reviews:       Number,
  badge:         String,   // e.g. "Best Seller", "New"
  image:         String,   // URL
  stock:         Number | null,  // null = unlimited
  reserved:      Number    // quantity currently in user carts
}
```

### Cart

```js
{
  userId: String  (indexed),
  items: [
    {
      productId: Number,
      quantity:  Number
    }
  ]
}
```

### Order

```js
{
  userId:    String,
  items: [
    {
      productId: Number,
      quantity:  Number,
      price:     Number   // snapshotted at purchase time
    }
  ],
  total:     Number,
  status:    String,      // "created" | "paid" | "failed"
  createdAt: Date
}
```

### UserProfile

```js
{
  userId:                   String  (unique, Firebase UID),
  isFirstLogin:             Boolean,
  discountUsed:             Boolean,
  discountPercent:          Number,   // default: 10
  email:                    String,   // synced from Firebase on login
  firstPurchaseEmailSentAt: Date,     // prevents duplicate welcome emails
  lastReminderEmailSentAt:  Date,     // tracks re-engagement emails
  name:                     String,
  phone:                    String,
  addresses: [{
    id:        String,
    label:     String,
    line1:     String,
    line2:     String,
    city:      String,
    state:     String,
    zip:       String,
    country:   String,
    phone:     String
  }],
  defaultAddressId: String,
  createdAt:        Date,
  updatedAt:        Date
}
```

### Bug

```js
{
  title:         String  (required),
  description:   String  (required),
  steps:         String,
  pageUrl:       String,
  browser:       String,
  reporterName:  String,
  reporterEmail: String,
  status:        String,  // "open" | "in-progress" | "resolved"
  createdAt:     Date,
  updatedAt:     Date
}
```

### FitnessCenter

```js
{
  name:     String  (required),
  type:     String, // "gym" | "yoga" | "pilates" | "fitness_studio"
  address:  String,
  city:     String,
  state:    String,
  lat:      Number,
  lng:      Number,
  rating:   Number, // 0–5
  imageUrl: String,
  contact:  String,
  isOpen:   Boolean
}
```

### Rewards

```js
{
  userId: String,  // Firebase UID
  points: Number,  // Total rewards points
  tier:   String,  // e.g. "bronze", "silver", "gold"
  history: [{
    action: String,  // e.g. "purchase", "review", "referral"
    points: Number,
    date:   Date
  }]
}
```

### WorkoutLog

```js
{
  userId:   String,  // Firebase UID
  date:     Date,    // Workout date
  exercises: [{
    name:     String,  // Exercise name
    sets:     Number,
    reps:     Number,
    weight:   Number,  // in kg
    duration: Number   // in minutes
  }],
  notes:    String,
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🎨 Design System

FitMart uses a **luxury refined minimalism** design language — clean, editorial, and spacious. Full details are in [`client/DesignSystem.md`](client/DesignSystem.md).

### Color Palette (`stone-*` only)

| Role | Tailwind Class | Usage |
|---|---|---|
| Primary / Dark BG | `stone-900` | Buttons, navbars, dark sections |
| Borders | `stone-200` | Card borders, dividers |
| Subtle BG | `stone-100` | Page backgrounds, hover states |
| Main BG | `stone-50` | Default page background |
| Cards | `white` | Cards, inputs, modals |

> ⚠️ **No other color families** (no blue, green, purple). All accent colors use `stone-*`.

### Typography

- **Headings:** `DM Serif Display`
- **Body / UI:** `DM Sans`

### Animations

- Page transitions powered by **Framer Motion**
- Micro-interactions for buttons, modals, and cart drawer
- Entrance animations for product cards and sections

### Key Component Patterns

- **Buttons:** Always `rounded-full` (pill shape)
- **Cards:** Always `rounded-2xl`
- **Inputs:** `rounded-lg` with `focus:border-stone-900`
- **Section headings:** Always preceded by a `text-xs tracking-[0.2em] uppercase text-stone-400` eyebrow label

---

## 👑 Admin Panel

The admin panel is accessible only to the account whose Firebase UID matches `VITE_ADMIN_UID`.

### Accessing Admin

1. Set `VITE_ADMIN_UID` in `client/.env` to your Firebase user UID
2. Sign in with that account — you'll be automatically redirected to `/admin/dashboard`

### Admin Features

**Dashboard (`/admin/dashboard`)**
- KPI cards: Total Revenue, Total Orders, Customers, Low Stock count
- Revenue over time (Area chart)
- Top 5 selling products (horizontal Bar chart)
- Recent orders table with customer info and status badges
- Time range filter: Today / Week / Month
- Quick navigation cards to Inventory, Customers, Reports, Marketing, and Bugs

**Inventory (`/admin/inventory`)**
- Real-time stock levels for all products
- Status badges: In Stock / Low Stock / Unlimited
- Filter pills by stock status
- Stock, Reserved, and Available columns

**Customers (`/admin/customers`)**
- All customers sorted by spend
- Segment badges: `new` / `returning` / `high-value`
- Click through to individual customer profiles

**Customer Detail (`/admin/customers/:userId`)**
- Customer avatar, name, email, Firebase UID
- KPI cards: Order Count, Total Spend, First Order, Last Order
- Expandable order history with line-item breakdown

**Reports (`/admin/reports`)**
- Summary KPIs: Total Revenue, Total Orders, Avg Order Value
- Revenue by date table
- Product performance ranking
- Time range: Daily / Weekly / Monthly

**Marketing (`/admin/marketing`)**
- Curated digital marketing strategy cards tailored to FitMart's e-commerce context
- Each card covers: strategy overview, how it applies to FitMart, and key benefits

**Bug Tracker (`/admin/bugs`)**
- Table of all user-submitted bug reports
- Columns: title, reporter, page URL, browser, status, submission date
- One-click status transitions: `open` → `in-progress` → `resolved`
- Mobile-responsive card layout for small screens

---

## 📝 Notes & Recommendations

- **API URL consistency** — Use `VITE_API_URL` consistently across all client files. Replacing any remaining hardcoded `http://localhost:5000` references is a great first contribution!
- **Cart reservation** — `Product.reserved` increments on cart add and decrements on cart remove/clear. Orders finalize the reservation but don't re-release it — this is intentional.
  > Reservation updates use atomic `findOneAndUpdate` operations to prevent race conditions under concurrent cart activity.
- **Razorpay** — Always verify payments server-side with HMAC. Never expose `RAZORPAY_KEY_SECRET` to the client.
- **Firebase** — Only client-facing Firebase config keys go in the Vite `.env`. Never put service account credentials in the client `.env`.
- **Demo payment** — A "Simulate Success" bypass button is available on the payment page for testing without a real Razorpay transaction. Remove or guard this in production.
- **Admin UID** — The admin guard is purely UID-based. For production, consider role-based access control stored in your database.
- **Gemini chatbot** — The chatbot falls back to curated static responses when `GEMINI_API_KEY` is unset or the API is unavailable, so the widget is never broken for end users.
- **Email service** — The email service is fully optional. If SMTP variables are missing, emails are silently skipped and the rest of the purchase flow is unaffected.
- **Workout data** — Workout notes and calendar events are stored in `localStorage`. They are device-local and not synced to the server.
- **Security** — To report a vulnerability responsibly, see [`docs/SECURITY.md`](docs/SECURITY.md).
- **Rate limiting** — General API routes are limited to 100 requests per 15 minutes. Payment endpoints have a stricter limit of 20 requests per 15 minutes.

---

## 🤝 Contributing

We love contributions! FitMart is an open-source, community-driven project and contributions of all kinds are welcome — from fixing typos to building new features.

Please read **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** for a full guide on:
- Setting up your development environment
- Picking and working on issues
- Submitting a Pull Request
- Code style and commit conventions

**New to open source?** Look for issues labelled [`good first issue`](https://github.com/parthbuilds-community/FitMart/labels/good%20first%20issue) — they're perfect starting points! 🌱

---

## 👥 Contributors

Thanks to everyone who has contributed to FitMart.

<a href="https://github.com/parthbuilds-community/FitMart/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=parthbuilds-community/FitMart" alt="FitMart contributors" />
</a>

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

Made with ❤️ by [Parth Narkar](https://github.com/parthnarkar) and the [Parth Builds Community](https://www.instagram.com/parth.builds/)

⭐ **Star this repo** if you find it useful — it helps a lot!

</div>



next 

<p align="center">
  <img src="web/assets/calorie%20logo%20transparent.png" width="120" height="120" alt="Fud AI Logo">
</p>

<h1 align="center">Fud AI</h1>

<p align="center">
  <strong>Eat Smart, Live Better</strong><br>
  Snap, speak, or type your food — AI handles the rest.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/iOS-17.6+-blue?logo=apple" alt="iOS">
  <img src="https://img.shields.io/badge/Android-8.0+-green?logo=android" alt="Android">
  <img src="https://img.shields.io/badge/swift-5-orange?logo=swift" alt="Swift">
  <img src="https://img.shields.io/badge/kotlin-2.2-7F52FF?logo=kotlin" alt="Kotlin">
  <img src="https://img.shields.io/badge/UI-SwiftUI%20%2F%20Compose-purple" alt="UI">
  <img src="https://img.shields.io/badge/privacy-local--first-brightgreen" alt="Local-first privacy">
  <img src="https://img.shields.io/badge/languages-iOS%2016%20%2F%20Android%2015-blue" alt="iOS 16 languages / Android 15 languages">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <a href="https://github.com/apoorvdarshan/fud-ai/stargazers"><img src="https://img.shields.io/github/stars/apoorvdarshan/fud-ai?style=flat&logo=github&color=yellow" alt="GitHub stars"></a>
  <a href="https://apps.apple.com/us/app/fud-ai-calorie-tracker/id6758935726"><img src="https://img.shields.io/badge/App%20Store-Download-black?logo=apple" alt="App Store"></a>
  <a href="https://play.google.com/store/apps/details?id=com.apoorvdarshan.calorietracker"><img src="https://img.shields.io/badge/Google%20Play-Download-414141?logo=googleplay" alt="Google Play"></a>
</p>

---

Open-source, privacy-first calorie tracker for iOS and Android. Bring your own AI provider — 13 supported including Gemini, OpenAI, Claude, Grok, Groq, Hugging Face, Fireworks AI, DeepInfra, Mistral, and any custom OpenAI-compatible endpoint. Capture or import up to 10 food photos with an optional note, scan a barcode, ask your AI coach how to hit your goal, speak your lunch, or use Siri Shortcuts on iOS to log food and weight. On supported iPhones, food-description analysis for text, voice-transcribed, and Siri food logs can use Apple Intelligence on-device as the final fallback after BYOK provider/fallback attempts fail. No accounts, Fud AI cloud sync, tracking, or ads — completely free.

iOS and Android 6.0 (build/versionCode 33) add the same end-to-end strength workout experience: a local workout diary and logger with date navigation, sets, reps, weight, RPE, calculated calorie-burn history, Health sync, Coach access, and an in-place switch to the 873-exercise library. The last workout view stays selected, while new installs open the diary first.

The release also adds faster Saved Meal reuse, current-time meal copying, export of every stored nutrient, selectable water units, water progress on Apple Watch, current AI model presets, configurable timeouts for Ollama/custom endpoints, and reliability fixes across widgets, settings, images, and provider responses. Normal updates preserve existing local and Health data.

[App Store](https://apps.apple.com/us/app/fud-ai-calorie-tracker/id6758935726) · [Google Play](https://play.google.com/store/apps/details?id=com.apoorvdarshan.calorietracker) · [Website](https://fud-ai.app) · [Report an Issue](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=bug&title=Bug:%20) · [Request a Feature](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=enhancement&title=Feature:%20)

---

## Features

### Logging
- **Photo & Scan menu** — a focused submenu for Camera, Photos, and Barcode
- **Multi-photo Camera** — keep taking photos, review them horizontally, add an optional note, then analyze up to 10 separate images together
- **iOS Share Extension** — send a food photo from Photos or another app directly into Fud AI for review and logging
- **Barcode lookup** — scan packaged foods on iOS and Android and fill nutrition from Open Food Facts when product data is available
- **Multi-photo library import** — select up to 10 existing images, add an optional note, and analyze them together
- **Text input** — type food descriptions
- **Voice input** — speak your meals hands-free (6 STT options with per-provider language selection, see below)
- **iOS Siri Shortcuts** — say phrases like "Log food in Fud AI", "Calories today in Fud AI", or "Log my weight in Fud AI"; the phrase guide lives under + → Describe Meal → Siri Phrases
- **Manual Entry** — log known calories and macros without AI
- **Smart serving units** — AI can show slices, pieces, cups, ml, or other visible serving units while grams stay the source of truth
- **Review nutrition unlock** — correct calories, macros, and detailed nutrients before logging, then lock again so serving changes scale from your edits
- **Meal What if?** — preview how a reviewed meal changes today's calories and macros, then ask AI for a practical suggestion before logging
- **Saved Meals** — Recents, Frequent, and Favorites with safer swipe actions, search, and drag-to-reorder
- **Retryable analysis** — failed image analysis offers Retry and Cancel without limiting the number of retries

### Intelligence
- **AI Coach tab** — multi-turn chat with memory. Coach can retrieve relevant profile, weight, body-fat, nutrition, and workout context, then answer questions like "what's my expected weight in 30 days?" or "how did my training go this week?". Camera/photo attachments work on both platforms. Memory persists across launches; Reset starts a fresh conversation. Long-press any reply to copy.
- **AI Access** — free Bring Your Own Key: pick provider, model, fallback, custom instructions, and speech language directly on device. (The optional Fud AI Premium proxy from earlier iOS versions has been discontinued.)
- **Apple Intelligence fallback** — on supported iPhones, food-description analysis for text, voice-transcribed, and Siri food logs can use Apple Intelligence on-device as the final fallback after BYOK provider/fallback attempts fail.
- **AI optional nutrient goals** — estimate detailed nutrient goals from profile data without changing calorie/protein/carbs/fat formulas.
- **Goal-aware prompt chips** — suggested questions change based on whether your goal is Lose / Gain / Maintain
- **Thermodynamic weight forecast** — expected weight at 30/60/90 days, predicted vs observed weekly change, days-to-goal, under-logging detection. Surfaced through Coach as live context on every turn.
- **Resilient requests** — transient provider overloads (503 / 529 / 429) auto-retry with 1s / 2s / 4s exponential backoff across both food analysis and Coach chat, so short spikes resolve invisibly

### Tracking
- **Expanded nutrients** per entry — macros plus sugar, fiber, fats, cholesterol, sodium, potassium, calcium, iron, magnesium, zinc, vitamins, folate, omega-3, and more when available
- **Custom Home nutrient cards** — swap the top cards from protein/carbs/fat to fiber, sodium, vitamin D, calcium, or other tracked nutrients
- **Optional nutrient goals** — set or AI-estimate goals for the non-macro nutrients; these stay separate from the calorie and macro calculator
- **Scrollable week calendar** — swipe to any past week, configurable start day
- **Food log sorting** — keep the default grouped view, or sort meal sections by latest logging order from the Home screen
- **Progress charts** — weight trends, calorie history, macro averages (1W to All Time)
- **Progress summaries** — weight and body-fat ranges show average and net change for the selected week, month, or longer window
- **Decimal nutrition totals** — macros and detailed nutrients preserve decimal precision in logs, Home, widgets, and View More
- **Weight History** — tap-to-delete past entries and sync supported deletions to Apple Health / Health Connect
- **Goal tracking** — set target weight, BMR/TDEE auto-calculation; goal-reached alert fires from both manual logs and Apple Health reads
- **Adaptive Goals** — weekly calorie correction from observed weight trend; pinned macros stay pinned and unlocked macros auto-balance. On by default for new installs (stays off if you hand-edit your plan during onboarding)
- **Six activity levels** — Sedentary, Light, Moderate, Active, Very Active, and Extra Active use work and training descriptions instead of step-count requirements
- **Custom meal times** — choose when Breakfast, Lunch, Dinner, and Snack begin; the app uses those boundaries for automatic meal grouping
- **Optional water tracking** — off by default; set any practical daily goal, quick-log one to three glasses or a custom amount, see progress below calories, and optionally schedule a local reminder

### Workouts
- **Workout diary & logger** — plan exercises by day, swipe between weeks, and log sets, reps, weight, and RPE without starting a timer
- **Calculated workout burn** — estimate a day's calorie burn from the logged work, review or delete burn history in Progress, and optionally sync those records with Apple Health / Health Connect
- **Exercise library** — switch in place to 873 exercises with photos, primary/secondary muscle and equipment filters, search, sort, and per-exercise detail pages; the last diary/library view persists
- **Coach workout context** — Coach can retrieve workout plans, preferences, completed sessions, sets, reps, RPE, and calculated burn when answering training questions

### Health & platform
- **Apple Health** — bidirectional sync for body measurements, meal nutrition, and calculated workout calories; Siri food/weight logs use the same HealthKit paths, and Energy Burn Goals can estimate calorie targets from active/total energy while macros stay editable
- **Health Connect** — Android sync for nutrition, weight, body fat, and calculated workout calories, with permission reconciliation and backfill support; Energy Burn Goals can use recent energy data for calorie targets
- **Restore after a reinstall** — on a fresh install or new phone, food, weight, body-fat, and calculated workout-burn records previously written by Fud AI can restore from Apple Health / Health Connect; local workout plans and set details require an OS backup/device transfer
- **Apple Watch** — watchOS app and complications show calories, macros, and compact water progress when water tracking is enabled
- **Widgets** — iOS offers Fud AI in Small, Medium, and Large, small Protein, and a separate small/Lock Screen Water widget; Android offers Calorie, Protein, Today, and Water Glance widgets that update from local snapshots
- **Share the App** — native iOS share sheet from About → forwards App Store URL plus a personalized message and `fud-ai.app` link; message body localized into all 16 iOS languages
- **Update check** — About shows the installed app version, opens the App Store / Play Store when a newer version is available, and shows a tab dot for pending updates
- **Theme color** — iOS and Android Settings let users change the app accent, with matching home screen / launcher icons
- **Languages** — iOS supports 16 languages: Arabic, Azerbaijani, Dutch, English, French, German, Hindi, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Romanian, Russian, Simplified Chinese, Spanish. Android supports the same set except Polish. The app auto-selects by the phone's Language setting.
- **Meal reminders** — customizable breakfast, lunch, dinner notifications
- **Dark mode** — system, light, or dark
- **Metric & imperial** units

## AI Providers

Pick any of the **13 LLM providers** for food analysis, meal what-if suggestions, optional nutrient-goal estimation, and Coach chat. Free Gemini keys are available at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Requests go directly from your device to the provider you configure. For text, voice-transcribed, and Siri food descriptions on supported iPhones, Apple Intelligence can run on-device only as the last fallback after BYOK provider/fallback attempts fail.

| Provider | Format | Highlight | Needs API Key |
|----------|--------|-----------|:---:|
| Google Gemini | Gemini API | Gemini 3.5 Flash-Lite (default) / 3.6 Flash / 3.5 Flash | Yes |
| OpenAI | OpenAI | GPT-5.4 Mini (default) / 5.5 / 5.4 Nano | Yes |
| Anthropic Claude | Messages API | Sonnet 5 (default) / Opus 4.8 / Haiku 4.5 | Yes |
| xAI Grok | OpenAI-compatible | Grok 4.3 | Yes |
| OpenRouter | OpenAI-compatible | Any model, free-form IDs | Yes |
| Together AI | OpenAI-compatible | Qwen 3.5, Gemma 4, MiniMax M3 | Yes |
| Groq | OpenAI-compatible | Qwen 3.6, very fast | Yes |
| Hugging Face | OpenAI-compatible | Gemma 4 / 3 and Qwen 3.5 / 2.5 VL (open-weight router, free-form IDs) | Yes |
| Fireworks AI | OpenAI-compatible | Qwen 3.7 Plus, MiniMax M3, Kimi K2.6 | Yes |
| DeepInfra | OpenAI-compatible | Gemma 4 / 3 vision models | Yes |
| Mistral | OpenAI-compatible | Mistral Small / Medium, Ministral 14B | Yes |
| Ollama | OpenAI-compatible (local) | Qwen 3 VL, Gemma 4, Llama 3.2 Vision, LLaVA, Moondream | No |
| Custom (OpenAI-compatible) | OpenAI-compatible | You set base URL + free-form model name | Optional |

## Speech-to-Text Providers

Pick how voice input is transcribed. Native iOS / Android is the default — free, on-device where supported, real-time. On Android, native speech first tries the on-device language path, then falls back to Android recognition with network/provider defaults if the phone lacks offline support for that language. Each provider has its own language setting: use Provider Auto, Use Device Language, or an explicit language hint where supported.

| Provider | Notes |
|----------|-------|
| Native iOS / Android (On-Device) | Free, offline where the phone supports the selected language, real-time partial results |
| Gemini Audio | Batch audio transcription through Gemini for BYOK users |
| OpenAI Whisper | Whisper-1 via `/v1/audio/transcriptions` |
| Groq (Whisper) | Whisper-large-v3, very fast, has a free tier |
| Deepgram | Nova-3, fast and accurate |
| AssemblyAI | Universal model, strong accuracy, free tier |

For Android phones where native speech is inconsistent, Groq (Whisper) or Deepgram are recommended alternatives; the developer currently uses Groq.

API keys are stored encrypted on-device: **iOS Keychain** on iOS and **EncryptedSharedPreferences backed by Android Keystore** on Android.

## How It Works

```
Photo(s) / Text / Voice
        │
        ▼
  BYOK provider API
        │
        ├── BYOK provider fallback if configured
        └── iOS Apple Intelligence final fallback for text / voice transcript / Siri food descriptions
        │
        ▼
  JSON nutrition response
        │
        ▼
  User reviews & edits
        │
        ▼
  FoodStore.addEntry()  ──▶  UserDefaults (local) + Apple Health (optional)
```

For the Coach chat, every turn builds a slim system prompt from your live profile, BMR formula in use, computed forecast, today's date/timezone, and a one-line snapshot of available data. Coach then pulls any date range of weight, body fat, calorie totals, or food entries on demand via tool calling — ask "what was my weight in March?" or "show me my body fat trend over the last 6 months" and it fetches exactly the slice it needs, including meal source, meal type, serving size, and micronutrients.

## Screenshots

An eight-screen walkthrough of the current app flow — from the dashboard and grouped logging menu through review, progress, Coach, and Workouts.

<table>
  <tr>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/home.png" width="230" alt="Home dashboard">
      <br><br>
      <b>01 · Home · Dashboard</b>
      <br>
      <sub>Daily calorie ring, selected Home nutrient cards, and today's logged meals grouped by meal type. Week strip at the top for date navigation.</sub>
    </td>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/logging.png" width="230" alt="Grouped food logging options menu">
      <br><br>
      <b>02 · Log · Options</b>
      <br>
      <sub>Tap + for Photo &amp; Scan, Describe Meal, Reuse Meal, and optional Water groups. Camera and Photos accept up to 10 images plus an optional note.</sub>
    </td>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/snap.png" width="230" alt="Snap food capture">
      <br><br>
      <b>03 · Snap · Capture</b>
      <br>
      <sub>Point and shoot. The image is sent to your chosen AI provider; nutrition estimates come back within a few seconds.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/review.png" width="230" alt="Review food entry">
      <br><br>
      <b>04 · Review · Edit</b>
      <br>
      <sub>Review the AI's guess, unlock nutrition if values need correction, adjust the serving size (everything recalculates live), preview "What if?" impact, and pick a meal type before logging.</sub>
    </td>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/meals.png" width="230" alt="Meals log">
      <br><br>
      <b>05 · Meals · Log</b>
      <br>
      <sub>The day's entries grouped by breakfast / lunch / dinner / snack. Swipe to delete, tap to edit any entry.</sub>
    </td>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/coach.png" width="230" alt="AI Coach chat">
      <br><br>
      <b>06 · Coach · AI Chat</b>
      <br>
      <sub>Multi-turn conversation with full context of your profile, weight history, food log, and forecast. Ask "what should I eat?" or "expected weight in 30 days?".</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/progress.png" width="230" alt="Progress charts">
      <br><br>
      <b>07 · Progress · Charts</b>
      <br>
      <sub>Weight trend with goal line, calorie history (intake vs. goal), and macro averages. Time ranges span 1 week to all time.</sub>
    </td>
    <td align="center" width="33%">
      <img src="web/assets/screenshots/workouts.png" width="230" alt="Workout exercise library">
      <br><br>
      <b>08 · Workouts · Library</b>
      <br>
      <sub>Browse 873 exercises with photos, filterable by primary/secondary muscle and equipment, with search, sort, and per-exercise detail pages.</sub>
    </td>
  </tr>
</table>

## Calorie & Macro Calculation

The app calculates personalized daily targets using established nutrition science formulas:

| Step | Formula | Details |
|------|---------|---------|
| **BMR** | Katch-McArdle | `370 + 21.6 × lean mass (kg)` — used when body fat % is known |
| **BMR** | Mifflin-St Jeor | `10w + 6.25h − 5a ± 5` — fallback when body fat is unknown |
| **TDEE** | BMR × activity | Multiplier ranges from 1.2 (sedentary) to 1.9 (extra active) |
| **Daily Calories** | TDEE + adjustment | Adjustment = `weeklyChangeKg × 7700 / 7` (deficit or surplus) |
| **Protein** | Activity + goal | `0.8 – 2.2 g/kg` body weight by activity, plus +0.2 g/kg during cutting phase (Helms et al 2014); when body fat % is known, Activity Level also shows the equivalent g/kg lean-mass multiplier |
| **Fat** | Fixed ratio | `0.6 g/kg` body weight |
| **Carbs** | Auto-balanced | Remainder from calories − protein − fat (any macro can be pinned; max 2 pinned) |

All values can be manually overridden in Settings, with a **Recalculate Goals** button to snap back to formula defaults.

## Architecture

| Component | Details |
|-----------|---------|
| **Language** | Swift 5, SwiftUI, iOS 17.6+ |
| **Storage** | UserDefaults (local JSON), Keychain (API keys) |
| **AI** | `GeminiService` for food + label analysis, `ChatService` for multi-turn Coach chat, both route across all 13 providers |
| **Speech** | Native `SFSpeechRecognizer` / Android `SpeechRecognizer` or remote providers via `SpeechService` (m4a upload) |
| **Health** | HealthKit / Health Connect read-write paths for body measurements, meal nutrition, and calculated workout calories, with UUID-tagged samples for safe delete |
| **Pattern** | `@Observable` + `.environment()`, main actor isolation |
| **Localization** | `Localizable.xcstrings` (String Catalog), 16 iOS languages, auto-selected by iPhone's system language |
| **Dependencies** | Native platform frameworks; app data and API keys remain local |

### Repo Layout

```
fud-ai/
├── ios/          # SwiftUI iOS app (v6.0 build 33)
├── android/      # Kotlin + Jetpack Compose app (min SDK 26 / Android 8.0, v6.0 / versionCode 33)
├── web/          # Marketing site — https://fud-ai.app (static HTML/CSS, Cloudflare Workers)
├── APPSTORE.md   # App Store Connect listing copy (iOS)
├── PLAYSTORE.md  # Google Play Console listing copy (Android)
└── README, LICENSE, CONTRIBUTING, SECURITY, .github/
```

### Source Layout (iOS)

```
ios/
├── calorietracker.xcodeproj/         # Xcode project
├── calorietrackerTests/              # Unit test target (boilerplate)
├── calorietrackerUITests/            # UI test target (boilerplate)
├── FudAIWidgets/                     # Widget extension target (Home + Lock Screen)
├── screenshots/                      # App Store screenshot sources
└── calorietracker/
    ├── calorietrackerApp.swift       # Entry point, environment setup
    ├── ContentView.swift             # 5-tab layout (Home, Progress, Coach, Settings, Workouts)
    ├── Localizable.xcstrings         # String Catalog, 16 languages
    ├── Models/
    │   ├── AIProvider.swift          # 13 LLM providers, model lists, settings
    │   ├── SpeechProvider.swift      # 6 STT options + Keychain settings
    │   ├── ChatMessage.swift         # Coach chat message model
    │   ├── UserProfile.swift         # BMR/TDEE/macro calculations
    │   ├── FoodEntry.swift           # Food item with macros and expanded optional nutrients
    │   └── WeightEntry.swift         # Weight log entry
    ├── Views/
    │   ├── OnboardingView.swift      # 15-step onboarding flow
    │   ├── ChatView.swift            # Coach tab: bubbles, prompt chips, reset
    │   ├── FoodResultView.swift      # AI result review & edit
    │   ├── RecentsView.swift         # Saved Meals (Recents / Frequent / Favorites)
    │   ├── VoiceInputView.swift      # Native + remote STT routing
    │   ├── HomeComponents.swift      # Week strip, macro cards
    │   └── ProgressComponents.swift  # Charts, weight history
    ├── Services/
    │   ├── GeminiService.swift       # Food/label analysis, routes 13 providers
    │   ├── ChatService.swift         # Multi-turn Coach chat, routes 13 providers
    │   ├── SpeechService.swift       # Remote STT router (Gemini / OpenAI / Groq / Deepgram / AssemblyAI)
    │   ├── WeightAnalysisService.swift # Thermodynamic weight-forecast math
    │   ├── KeychainHelper.swift      # iOS Keychain wrapper
    └── Stores/
        ├── FoodStore.swift            # Food CRUD + favorites
        ├── WeightStore.swift          # Weight CRUD (auto-syncs profile weight)
        ├── ProfileStore.swift         # @Observable wrapper over UserProfile
        ├── ChatStore.swift            # Coach chat history (persisted locally)
        ├── NotificationManager.swift  # Local notification scheduler, including optional water reminders
        ├── WaterStore.swift           # Local water entries and daily goal
        ├── StrengthWorkoutStore.swift # Local workout diary, sets, and burn history
        └── HealthKitManager.swift     # Apple Health bridge (body + nutrition + workout burn)
```

## Build & Run

```bash
# Clone
git clone https://github.com/apoorvdarshan/fud-ai.git
cd fud-ai
```

### iOS

```bash
xcodebuild -project ios/calorietracker.xcodeproj \
  -scheme calorietracker \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Open `ios/calorietracker.xcodeproj` in Xcode, select your device, and run.

### Android

Open `android/` in Android Studio (Narwhal or newer), let Gradle sync, hit ▶ Run. Or from the CLI:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.apoorvdarshan.calorietracker/.MainActivity
```

First launch walks you through onboarding (gender, birthday, height/weight with metric/imperial toggle, body fat %, one of six activity levels with a protein-target preview, goal, goal speed, notifications, Apple Health / Health Connect, AI access setup, and review). A free Gemini key is available at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). You can change provider anytime in **Settings → AI Access**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Bug reports and feature requests welcome.

Adding a new translation? Open `ios/calorietracker/Localizable.xcstrings` in Xcode and fill in your language column — everything else is already wired.

## Security

See [SECURITY.md](SECURITY.md). Use [private vulnerability reporting](https://github.com/apoorvdarshan/fud-ai/security/advisories/new) for sensitive issues.

## Privacy

No accounts, Fud AI-operated cloud sync, or analytics. BYOK API keys are protected by iOS Keychain or Android EncryptedSharedPreferences, and requests go directly to the provider you choose. Food, weight, body-fat, water, and workout logs, custom meal times, goals, preferences, cached images, and widget/Watch snapshots are local except for OS backup/device transfer and the specific AI/STT, barcode, health-sync, update-check, export, or sharing action you initiate. Shared meal links carry the selected meal details in the URL, so anyone with the link can read them. Apple Health / Health Connect access is optional and can be reviewed or revoked through Manage Access. **Delete All Data** wipes the current local installation, including saved keys, water history, and workout plans/history, but never removes Apple Health, Health Connect, or older OS backups. See the complete [Privacy Policy](https://fud-ai.app/privacy.html).

## License

MIT License. See [LICENSE](LICENSE).

## Contact

- **Developer:** Apoorv Darshan
- **Email:** apoorv@fud-ai.app or ad13dtu@gmail.com
- **Follow on X:** [@apoorvdarshan](https://x.com/apoorvdarshan)
- **Follow on Instagram:** [@fudai.app](https://www.instagram.com/fudai.app/)
- **Follow on LinkedIn:** [Fud AI](https://www.linkedin.com/company/fud-ai-app)
- **View on TrustMRR:** [Fud AI - Calorie Tracker](https://trustmrr.com/startup/fud-ai-calorie-tracker)
- **Report an Issue:** [github.com/apoorvdarshan/fud-ai/issues/new?labels=bug&title=Bug:%20](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=bug&title=Bug:%20)
- **Request a Feature:** [github.com/apoorvdarshan/fud-ai/issues/new?labels=enhancement&title=Feature:%20](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=enhancement&title=Feature:%20)

## Support the Project

Fud AI is fully free, open source, and privacy-first — no ads, no subscription. If it helps you, consider supporting development (on iOS there's an in-app Tip Jar under Settings → About) — every bit keeps this project alive.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi)](https://ko-fi.com/apoorvdarshan)
[![Product Hunt](https://img.shields.io/badge/Product%20Hunt-Vote-orange?logo=producthunt)](https://www.producthunt.com/products/fud-ai-calorie-tracker)

You can also help by [voting on Product Hunt](https://www.producthunt.com/products/fud-ai-calorie-tracker), [starring the repo](https://github.com/apoorvdarshan/fud-ai), [filing bugs](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=bug&title=Bug:%20), or [requesting features](https://github.com/apoorvdarshan/fud-ai/issues/new?labels=enhancement&title=Feature:%20).

## Star History

<a href="https://github.com/apoorvdarshan/fud-ai/stargazers">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://fud-ai.app/star-history.svg?theme=dark&amp;v=doodle-20260724" />
    <source media="(prefers-color-scheme: light)" srcset="https://fud-ai.app/star-history.svg?v=doodle-20260724" />
    <img alt="Fud AI GitHub star history chart" src="https://fud-ai.app/star-history.svg?v=doodle-20260724" />
  </picture>
</a>

## Contributors

Thanks to everyone who has contributed to making Fud AI better:

<a href="https://github.com/apoorvdarshan/fud-ai/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=apoorvdarshan/fud-ai&amp;max=100&amp;columns=12" alt="Contributors" />
</a>

## Credits

Exercise data, muscle glyphs, and barcode nutrition data come from open projects — see [ASSET_CREDITS.md](ASSET_CREDITS.md).

# Play Store Listing

Google Play Console listing copy for Fud AI Android v6.0 / versionCode 33. Each field is in a code block for easy copy-paste. Char counts are tracked because Play Console enforces hard caps and silently truncates anything over.

**Where to paste each field in Play Console:**
- App name / Short description / Full description → Grow → Store presence → **Main store listing** (default English) and Grow → Store presence → **Custom store listings** → Manage translations (per-language overrides)
- What's new → **Releases → Production / Closed testing → Create new release → Release notes** field (paste the entire `<lang-tag>` block; Play Console parses tags automatically)

---

## 1. App Name

**30 char hard cap per language.** Brand name stays as `Fud AI` untranslated; the descriptor after the dash is what gets localized. English-only on Play Console — non-English Play Store browsers see the English source as fallback.

### English (en-US) — 24 chars
```
Fud AI - Calorie Tracker
```

---

## 2. Short Description

**80 char hard cap per language. Cannot include price/promotion keywords ("free", "discount", "sale", "best", "#1", etc.) — Play Console will block promotion of the listing.** Live Play Store currently has "Snap, speak, or type a meal. AI logs the calories. Free & open source." which triggers the warning; replacement below drops "Free" while keeping the same rhythm. English-only on Play Console — non-English Play Store browsers see the English source as fallback.

### English (en-US) — 63 chars
```
Snap, speak, or type a meal. AI logs the calories. Open source.
```

---

## 3. Full Description

**4000 char hard cap per language.** This is the long-form "About this app" copy. English-only on Play Console — non-English Play Store browsers see the English source as fallback (deliberate decision; the in-app UI is fully translated via per-locale `values-{lang}/strings.xml` so users still get a localized experience once installed).

### English (en-US)
```
Fud AI makes calorie tracking effortless with AI-powered food recognition. Snap a photo, scan a barcode, speak it, or type it — get instant nutrition: calories, protein, carbs, fats, vitamins, minerals, and more.

NEW in v6.0: plan and log strength workouts with sets, reps, weight, and RPE. Estimate daily workout burn, review it in Progress, and optionally sync it with Health Connect. Switch between the diary and 873-exercise library; Fud AI remembers your view.

Meal reuse is faster, copied foods use the current time, and exports include every stored nutrient. Water tracking adds selectable units. AI presets use current models, with configurable Ollama/custom timeouts.

Open source, privacy-first. Bring your own API key.

WAYS TO LOG A MEAL
• Camera — take up to 10 photos, add an optional note
• Photos — import up to 10 images, add an optional note
• Barcode — Open Food Facts lookup
• Voice — 6 STT engines
• Text — describe it, AI parses it
• Manual Entry
• Saved Meals — recents, frequent, favorites
• Copy from Day — copy meals from another date

AI PROVIDERS
Use Gemini, OpenAI, Claude, Grok, Groq, OpenRouter, Together, Hugging Face, Fireworks, DeepInfra, Mistral, Ollama, or an OpenAI-compatible endpoint. Keys are encrypted.

6 SPEECH-TO-TEXT ENGINES
Native Android, Gemini, OpenAI Whisper, Groq, Deepgram, or AssemblyAI, with automatic or fixed language handling.

COACH
Multi-turn chat can access your profile, goals, food log, progress, and workouts when requested. Images are supported.

REVIEW BEFORE LOGGING
Unlock Nutrition to correct calories, macros, and detailed nutrients before saving; serving changes then scale from your edits. What if? previews today's macro impact and can ask AI for a suggestion.

WORKOUTS
Plan by day and log sets, reps, weight, and RPE without a timer. Swipe weeks, estimate calorie burn, and review history in Progress. The 873-exercise photo library includes muscle/equipment filters, search, sorting, and details.

PERSONALIZED GOALS
BMR and TDEE calculators, six activity levels, automatic or editable macro targets, and customizable meal-time boundaries.

OPTIONAL NUTRIENT GOALS
Set expanded nutrient goals separately from the macro calculator — fiber, sugar, fats, sodium, vitamins, minerals, and more. Use AI Estimate or set them manually. Home cards can show macros or selected nutrients.

WIDGETS
Separate Calorie, Protein, Today, and Water widgets in the Home speedometer style. They refresh from local snapshots when you log.

OPTIONAL WATER TRACKING
Off by default. Set your own daily goal, quick-log one to three glasses or a custom amount, view progress below calories, schedule a local reminder, and use the dedicated Water widget. Water history stays on your device and is not sent to Health Connect.

15 LANGUAGES
Auto-selected by phone language: English, Spanish, French, German, Italian, Portuguese (BR), Dutch, Russian, Japanese, Korean, Chinese, Hindi, Arabic, Romanian, Azerbaijani.

PRIVACY FIRST
No account, Fud AI cloud, analytics, behavioral tracking, or ads. Android backup may apply under system settings. Keys are encrypted; AI/STT requests go directly to your provider. MIT licensed.

HEALTH CONNECT
Optional sync for nutrition, weight, body fat, and calculated workout calories, plus energy reads for goal estimates. Records can restore from Health Connect after reinstall.

NOTE: Not medical advice. Estimates are AI-generated; consult a healthcare professional before significant diet changes.

Terms: https://fud-ai.app/terms.html
Privacy: https://fud-ai.app/privacy.html
Source: https://github.com/apoorvdarshan/fud-ai

```

### Other 14 languages
English-only on Play Console — non-English Play Store browsers (ar, az-AZ, de-DE, es-ES, fr-FR, hi-IN, it-IT, ja-JP, ko-KR, nl-NL, pt-BR, ro, ru-RU, zh-CN) see the English source as fallback. The app includes 14 localized interfaces; newer strings may temporarily use the English fallback.

---

## 4. What's New (v6.0 / versionCode 33)

**500 char hard cap per language.** Paste the entire block below into Play Console's "Release notes" field — it auto-routes each `<lang-tag>` block to the matching locale.

```
<en-US>
• New workout diary/logger: plan exercises, enter sets, reps, weight and RPE, estimate daily calorie burn, and review workout history.
• Switch between the logger and 873-exercise library; your last view stays selected.
• Faster meal reuse, complete nutrient export, and selectable water units.
• Updated AI model presets, configurable local/custom timeouts, Health Connect workout sync, and reliability fixes.
</en-US>

<ar>
• يوميات ومسجل تمارين جديد: خطط للتمارين وسجل المجموعات والتكرارات والوزن وRPE والسعرات.
• بدّل بين المسجل ومكتبة تضم 873 تمرينًا، مع حفظ آخر عرض.
• إعادة استخدام أسرع للوجبات، وتصدير كامل للمغذيات، ووحدات ماء قابلة للاختيار.
• نماذج AI محدثة ومزامنة التمارين مع Health Connect وتحسينات للموثوقية.
</ar>

<az-AZ>
• Yeni məşq gündəliyi: hərəkətləri planlayın, set, təkrar, çəki, RPE və kalori sərfini qeyd edin.
• Gündəliklə 873 hərəkətlik kitabxana arasında keçin; son görünüş yadda qalır.
• Yeməkləri daha sürətli təkrar istifadə edin, bütün qidaları ixrac edin və su vahidini seçin.
• Yenilənmiş AI modelləri, Health Connect məşq sinxronu və etibarlılıq düzəlişləri.
</az-AZ>

<de-DE>
• Neues Trainingstagebuch: Übungen planen und Sätze, Wiederholungen, Gewicht, RPE und Kalorien erfassen.
• Zwischen Logger und Bibliothek mit 873 Übungen wechseln; die letzte Ansicht bleibt gewählt.
• Mahlzeiten schneller wiederverwenden, alle Nährstoffe exportieren und Wassereinheit wählen.
• Aktualisierte KI-Modelle, Health-Connect-Trainingssync und Zuverlässigkeitskorrekturen.
</de-DE>

<es-ES>
• Nuevo diario de entrenamiento: planifica ejercicios y registra series, repeticiones, peso, RPE y calorías.
• Cambia entre el registro y la biblioteca de 873 ejercicios; se conserva la última vista.
• Reutiliza comidas más rápido, exporta todos los nutrientes y elige la unidad de agua.
• Modelos de IA actualizados, sincronización de entrenos con Health Connect y mejoras de fiabilidad.
</es-ES>

<fr-FR>
• Nouveau journal d'entraînement : planifiez puis notez séries, répétitions, poids, RPE et calories.
• Basculez entre le journal et la bibliothèque de 873 exercices ; la dernière vue est mémorisée.
• Réutilisation des repas accélérée, export de tous les nutriments et unité d'eau au choix.
• Modèles IA actualisés, synchronisation Health Connect et correctifs de fiabilité.
</fr-FR>

<hi-IN>
• नया वर्कआउट लॉगर: व्यायाम प्लान करें और सेट, रेप, वजन, RPE व कैलोरी बर्न दर्ज करें।
• लॉगर और 873 व्यायामों की लाइब्रेरी के बीच बदलें; पिछला दृश्य याद रहता है।
• भोजन जल्दी दोबारा उपयोग करें, सभी पोषक तत्व निर्यात करें और पानी की इकाई चुनें।
• नए AI मॉडल, Health Connect वर्कआउट सिंक और विश्वसनीयता सुधार।
</hi-IN>

<it-IT>
• Nuovo diario allenamenti: pianifica esercizi e registra serie, ripetizioni, peso, RPE e calorie.
• Passa tra diario e libreria di 873 esercizi; l'ultima vista resta selezionata.
• Riutilizzo pasti più rapido, esportazione di tutti i nutrienti e unità dell'acqua selezionabile.
• Modelli IA aggiornati, sincronizzazione allenamenti Health Connect e correzioni di affidabilità.
</it-IT>

<ja-JP>
• 新しいワークアウト日記：種目を計画し、セット、回数、重量、RPE、消費カロリーを記録。
• ロガーと873種目のライブラリを切替。最後に開いた表示を保持します。
• 食事の再利用を高速化し、全栄養素の書き出しと水分単位の選択に対応。
• AIモデルを更新し、Health Connectの運動同期と信頼性を改善。
</ja-JP>

<ko-KR>
• 새 운동 일지: 운동을 계획하고 세트, 횟수, 무게, RPE와 칼로리 소모를 기록하세요.
• 로거와 873개 운동 라이브러리를 전환하며 마지막 화면이 유지됩니다.
• 식사 재사용 속도 향상, 모든 영양소 내보내기, 물 단위 선택 기능.
• 최신 AI 모델, Health Connect 운동 동기화 및 안정성 개선.
</ko-KR>

<nl-NL>
• Nieuw trainingsdagboek: plan oefeningen en log sets, herhalingen, gewicht, RPE en calorieën.
• Wissel tussen logger en bibliotheek met 873 oefeningen; de laatste weergave blijft gekozen.
• Maaltijden sneller hergebruiken, alle voedingsstoffen exporteren en watereenheid kiezen.
• Bijgewerkte AI-modellen, Health Connect-trainingssync en betrouwbaarheidsfixes.
</nl-NL>

<pt-BR>
• Novo diário de treino: planeje exercícios e registre séries, repetições, peso, RPE e calorias.
• Alterne entre o registro e a biblioteca de 873 exercícios; a última tela fica salva.
• Reutilize refeições mais rápido, exporte todos os nutrientes e escolha a unidade de água.
• Modelos de IA atualizados, sincronização de treinos com Health Connect e correções de estabilidade.
</pt-BR>

<ro>
• Jurnal nou de antrenament: planifică exerciții și notează seturi, repetări, greutate, RPE și calorii.
• Comută între jurnal și biblioteca cu 873 de exerciții; ultima vizualizare rămâne selectată.
• Refolosește mesele mai rapid, exportă toți nutrienții și alege unitatea pentru apă.
• Modele AI actualizate, sincronizare Health Connect și remedieri de fiabilitate.
</ro>

<ru-RU>
• Новый дневник тренировок: планируйте упражнения и записывайте подходы, повторы, вес, RPE и калории.
• Переключайтесь между дневником и библиотекой из 873 упражнений; последний экран сохраняется.
• Быстрее используйте блюда повторно, экспортируйте все нутриенты и выбирайте единицу воды.
• Обновлены модели ИИ, синхронизация тренировок Health Connect и надёжность.
</ru-RU>

<zh-CN>
• 新增训练日记：规划动作并记录组数、次数、重量、RPE 和消耗热量。
• 可在记录器与 873 个动作库之间切换，并保留上次视图。
• 更快复用餐食、导出全部营养素，并可选择饮水单位。
• 更新 AI 模型、Health Connect 训练同步及多项稳定性修复。
</zh-CN>
```

---

## 5. Categorization

```
App category: Health & Fitness
Tags: Calorie tracker, Nutrition, AI, Food tracker
```

## 6. Contact details

```
Email: apoorv@fud-ai.app
Phone: (omit — optional, US-only enforcement)
Website: https://fud-ai.app
Privacy policy: https://fud-ai.app/privacy.html
```

## 7. App content declarations

These are one-time setup in Play Console → Policy → App content. Don't drift from these answers across submissions:

- **Privacy policy URL**: https://fud-ai.app/privacy.html
- **App access**: All functionality available without restrictions
- **Ads**: No — v3.0.3 removed the AdMob banner and the ads SDK entirely. Set "contains ads" to No, and set the Advertising ID declaration to No (the `AD_ID` permission is gone from the manifest).
- **Content rating**: Everyone (E)
- **Target audience**: 13+
- **News app**: No
- **COVID-19 contact tracing**: No
- **Data safety**: The developer operates no Fud AI account, analytics, advertising, or app-data backend. Do not declare Advertising ID. Most app data is local, and API keys are stored in EncryptedSharedPreferences. User-initiated AI/STT requests send the selected photos/text/audio directly to the provider the user configures; barcode lookup sends the barcode to Open Food Facts; optional shared-meal links place selected meal data in the URL; optional Health Connect sync reads/writes the declared health types. Complete the Play form according to Google's current definitions for these direct user-initiated transfers rather than broadly claiming that no data is processed. Network requests use HTTPS except a user-configured local/custom endpoint may use the URL the user supplies. Delete All Data removes local app data but not Health Connect records.
- **Government app**: No
- **Financial features**: No
- **Health features**: Yes — nutrition, body measurements, energy-based goals, calculated workout calories, and optional local water tracking. Health Connect permissions are READ/WRITE nutrition, weight, body fat, and active calories burned, plus READ total calories burned. Water history is local and is not written to Health Connect. Explain restore/backfill, Energy Burn Goals, and calculated workout-burn sync in the permissions declaration, and keep the in-app rationale/Manage Access flow aligned with the privacy policy.