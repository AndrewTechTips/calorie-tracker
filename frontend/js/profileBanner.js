// Settings profile-card cover (profiles.profile_banner).
//
// A value is one of:
//   "preset:<id>"          — a bundled cover, public/assets/banners/<id>.webp
//                            (rendered from design/banners/<id>.svg — see
//                            that folder's README for why they are rasters)
//   "data:image/jpeg;..."  — the user's own photo, compressed below
// and anything else resolves to the default cover. The backend refuses every
// other shape (models.is_valid_profile_banner) — the check here mirrors it so
// a malformed value can never reach an <img src>.
//
// A local copy is kept per account (localStorage, keyed by user id) purely as
// a fallback: until sql/schema.sql's profile_banner column is applied, the
// backend drops the field from every save (db_tolerance.write_tolerant) and
// the server can't remember the choice. Once the column exists the server
// value always wins, so a cover picked on one device follows the account.

// Must match backend/models.py::PROFILE_BANNER_PRESETS and the SVG files.
// labelKey is the i18n key for the tile's accessible name.
export const BANNER_PRESETS = [
  { id: "ember", labelKey: "settings.bannerEmber" },
  { id: "aurora", labelKey: "settings.bannerAurora" },
  { id: "citrus", labelKey: "settings.bannerCitrus" },
  { id: "glacier", labelKey: "settings.bannerGlacier" },
  { id: "iron", labelKey: "settings.bannerIron" },
  { id: "grove", labelKey: "settings.bannerGrove" },
];
export const DEFAULT_BANNER = "preset:ember";

const PRESET_IDS = new Set(BANNER_PRESETS.map((p) => p.id));
const DATA_URI = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const LOCAL_KEY_PREFIX = "ironlog_profile_banner:";

// 3:1, matching the cover's own aspect in the card. 900px wide covers a
// ~400px card at 2x; the cover is decorative and sits under a soft fade, so
// going sharper only makes GET /targets heavier (the value rides along on
// every profile read, same as avatar_url).
const BANNER_WIDTH = 900;
const BANNER_HEIGHT = 300;
const BANNER_JPEG_QUALITY = 0.8;

export function isValidBanner(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("preset:")) return PRESET_IDS.has(value.slice("preset:".length));
  return DATA_URI.test(value);
}

export function presetValue(id) {
  return `preset:${id}`;
}

export function isCustomBanner(value) {
  return isValidBanner(value) && !value.startsWith("preset:");
}

function localKey(userId) {
  return userId ? LOCAL_KEY_PREFIX + userId : null;
}

// Every storage access is wrapped: a private window or a browser blocking
// site data throws on the accessor itself, and a cover is never worth
// breaking the profile render for.
function readLocal(userId) {
  const key = localKey(userId);
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalBanner(userId, value) {
  const key = localKey(userId);
  if (!key) return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Quota or blocked storage — the server copy (if migrated) still holds it.
  }
}

// The cover to show for this profile: the server's value when it has one,
// else this device's copy, else the default.
export function resolveBanner(targets) {
  const server = targets?.profile_banner;
  if (isValidBanner(server)) return server;
  const local = readLocal(targets?.id);
  if (isValidBanner(local)) return local;
  return DEFAULT_BANNER;
}

export function bannerSrc(value) {
  const v = isValidBanner(value) ? value : DEFAULT_BANNER;
  return v.startsWith("preset:") ? `assets/banners/${v.slice("preset:".length)}.webp` : v;
}

// Center-crops to 3:1 (so a portrait photo becomes a band across its middle
// rather than a squashed strip) and downsamples. Same canvas approach as
// avatar.js::fileToAvatarDataUrl. Throws when the browser cannot decode the
// file (e.g. HEIC outside Safari) — the caller shows the error.
export async function fileToBannerDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const targetRatio = BANNER_WIDTH / BANNER_HEIGHT;
    let sw = bitmap.width;
    let sh = Math.round(sw / targetRatio);
    if (sh > bitmap.height) {
      sh = bitmap.height;
      sw = Math.round(sh * targetRatio);
    }
    const sx = Math.round((bitmap.width - sw) / 2);
    const sy = Math.round((bitmap.height - sh) / 2);
    const width = Math.min(BANNER_WIDTH, sw);
    const height = Math.round(width / targetRatio);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", BANNER_JPEG_QUALITY);
  } finally {
    bitmap.close?.();
  }
}
