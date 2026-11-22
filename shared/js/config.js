// Avafon & Romyfon – gemeinsame Einstellungen. Die Seite (ava/romy) setzt
// avafon/side.js bzw. romyfon/side.js als window.AVAROMY_SIDE.
export const VERSION = "V1.02";

const S = (typeof window !== "undefined" && window.AVAROMY_SIDE) || { me: "ava", other: "romy", app: "Avafon" };
export const SIDE = Object.freeze({
  me: S.me,
  other: S.other,
  app: S.app,
  otherApp: S.otherApp || (S.other === "romy" ? "Romyfon" : "Avafon"),
});

// Pro App eigene Schlüssel (beide Apps liegen später auf demselben Origin).
const P = SIDE.app.toLowerCase();
export const STORAGE_CODE = `${P}-family-code`;
export const STORAGE_DEVICE = `${P}-device-id`;
export const MEDIA_CACHE = `${P}-media-v1.02`;

export function apiOrigin() {
  if (typeof window !== "undefined" && window.__AVAROMY_API__) return window.__AVAROMY_API__;
  const { protocol, hostname } = location;
  if (hostname === "127.0.0.1" || hostname === "localhost") return `${protocol}//${hostname}:8795`;
  return "https://avaromyfon.muellkuebel.workers.dev";
}

export function normalizeCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function getDeviceId() {
  let id = localStorage.getItem(STORAGE_DEVICE);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_DEVICE, id);
  }
  return id;
}
