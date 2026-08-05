// Client-side profile-picture handling for the header/Settings avatar.
//
// Two halves:
// 1. fileToAvatarDataUrl() — compresses/center-crops an uploaded photo to a
//    small square JPEG data: URI, the exact format profiles.avatar_url
//    stores (see sql/schema.sql's column comment for why a data: URI rather
//    than a Storage bucket path: this app has no Storage bucket provisioned
//    anywhere, and one small square photo comfortably fits a text column).
//    Same canvas-based downscale pattern as scan.js's compressImage/
//    makeRecentScanThumbnail — no new dependency for this.
// 2. generateInitialsAvatarUrl() — when no photo has been set, a
//    deterministic (same user always gets the same result — never a
//    different random avatar on every reload) locally-generated initials
//    avatar. Deliberately NOT a call to a third-party avatar service
//    (e.g. DiceBear): this app's whole posture (see CLAUDE.md) is zero new
//    external dependencies unless there's no local alternative, and an SVG
//    built from a tiny deterministic hash is a perfectly good "no photo yet"
//    placeholder that also happens to work fully offline.

const AVATAR_MAX_DIMENSION = 256;
const AVATAR_JPEG_QUALITY = 0.85;

export function isImageFile(file) {
  return Boolean(file && file.type && file.type.startsWith("image/"));
}

// Center-crops to a square (so an arbitrary-aspect-ratio photo doesn't get
// squashed into a circle) then downsamples to AVATAR_MAX_DIMENSION.
export async function fileToAvatarDataUrl(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const size = Math.min(AVATAR_MAX_DIMENSION, side);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", AVATAR_JPEG_QUALITY);
  } finally {
    bitmap?.close?.();
  }
}

// One of six accent gradients already used throughout this app (calories/
// protein/carbs/fats/water/fiber — see style.css's --c-*-rgb tokens) so a
// generated avatar always reads as "part of this app's palette," never an
// arbitrary color a hash could otherwise produce.
const PALETTE = [
  ["#ff6b4a", "#ff8a5c"],
  ["#33d6a6", "#5be0c2"],
  ["#ffc24b", "#ffd67a"],
  ["#8c9eff", "#aab7ff"],
  ["#4fc3f7", "#8fe2ff"],
  ["#8bc34a", "#a8d66a"],
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function initialsFrom(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// `seed` should be something stable per-user (email is the reliable one —
// always present; display_name is optional and can change) so the color
// never shifts across reloads/renames. `label` drives the initials shown —
// the display name when set, else the seed itself.
export function generateInitialsAvatarUrl(seed, label) {
  const key = seed || label || "?";
  const [c1, c2] = PALETTE[hashString(key) % PALETTE.length];
  const initials = initialsFrom(label || seed);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>` +
    `</linearGradient></defs>` +
    `<rect width="100" height="100" rx="50" fill="url(#g)"/>` +
    `<text x="50" y="53" text-anchor="middle" dy=".35em" font-family="'Space Grotesk','Inter',sans-serif" font-weight="700" font-size="38" fill="#17100c">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// The single entry point every avatar <img> in the app should be fed from:
// the real uploaded photo when one exists, otherwise the generated fallback.
export function resolveAvatarUrl({ avatar_url, email, display_name } = {}) {
  if (avatar_url) return avatar_url;
  return generateInitialsAvatarUrl(email, display_name);
}
