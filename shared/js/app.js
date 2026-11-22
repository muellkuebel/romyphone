// Avafon & Romyfon V1.01 – eine Codebasis, zwei Apps. Die Seite (ava/romy)
// kommt aus avafon/side.js bzw. romyfon/side.js.
//
// Bedienung (Kleinkind, ~2 Jahre): Auf dem Bildschirm ist nur das Foto des
// anderen Kindes. Foto antippen = anrufen. Klingelt es, ist der ganze
// Bildschirm „Annehmen“. Im Anruf gibt es nur den großen roten Auflegen-Knopf.
// Einstellungen: oben links 3 Sekunden gedrückt halten (nur für Erwachsene).
//
// Übernommen aus Hannafon V1.12: Signalisierung mit ping/pong + Warteschlange,
// erneute Zustellung eines klingelnden Anrufs (Push → App öffnet), geteilter
// entsperrter AudioContext + Keep-Alive, „Tippen zum Annehmen“, Kamera-Prime
// beim ersten Tippen, Bildschirm-Wachhalten, randloses Layout (100dvh,
// viewport-fit=cover, --ios-gap, Neu-Layout beim Drehen).
import { SIDE, VERSION, STORAGE_CODE, normalizeCode, getDeviceId } from "./config.js";
import {
  auth,
  loadConfig,
  mediaUrl,
  clearMediaCache,
  postSubscribe,
  postUnsubscribe,
  postPushTest,
  urlBase64ToUint8Array,
} from "./api.js";
import { Signaling } from "./signaling.js";
import {
  getLocalStream,
  createPeer,
  addIce,
  flushIce,
  stopStream,
  closePeer,
  applySendCaps,
  primeMediaPermission,
  refreshMediaPermissionState,
} from "./webrtc.js";
import {
  bindAudioUnlock,
  unlockAudio,
  startRingtone,
  stopRingtone,
  isRingAudible,
  setKeepAliveAllowed,
  setCallActive,
  audioDebug,
  audioContextState,
} from "./audio.js";

const $ = (id) => document.getElementById(id);
const ui = {
  app: $("app"),
  screens: {
    loading: $("screen-loading"),
    code: $("screen-code"),
    home: $("screen-home"),
    incoming: $("screen-incoming"),
    call: $("screen-call"),
  },
  codeForm: $("code-form"),
  codeInput: $("code-input"),
  codeError: $("code-error"),
  codeInstallHint: $("code-install-hint"),
  photoBtn: $("photo-btn"),
  homeStatus: $("home-status"),
  photos: [$("photo-home"), $("photo-incoming"), $("photo-call")],
  incomingTitle: $("incoming-title"),
  ringHint: $("ring-hint"),
  btnDecline: $("btn-decline"),
  remoteVideo: $("remote-video"),
  localVideo: $("local-video"),
  callStatus: $("call-status"),
  btnHangup: $("btn-hangup"),
  hotspot: $("settings-hotspot"),
  settingsProgress: $("settings-progress"),
  sheet: $("settings-sheet"),
  stConn: $("st-conn"),
  stOther: $("st-other"),
  stPush: $("st-push"),
  installHint: $("install-hint"),
  btnNotify: $("btn-notify"),
  btnPushTest: $("btn-push-test"),
  btnReset: $("btn-reset"),
  btnSettingsClose: $("btn-settings-close"),
  toast: $("toast"),
  btnSleep: $("btn-sleep"),
  night: $("night"),
  otherSleep: $("other-sleep"),
};

const OTHER_NAME = window.AVAROMY_SIDE?.otherName || (SIDE.other === "romy" ? "Romy" : "Ava");
const OUTGOING_RING_MS = 60000; // danach legt der Anrufer von selbst auf
const EXPECT_INCOMING_MS = 8000;

const state = {
  screen: "loading",
  code: null,
  config: null,
  photoUrls: {}, // { landscape, portrait }
  photoMeta: {}, // { landscape: {w,h,focus}, portrait: {...} }
  orient: null,
  signaling: new Signaling(),
  pc: null,
  localStream: null,
  remoteStream: null,
  inCall: false, // Anruf läuft (ausgehend oder angenommen)
  outgoing: false,
  connected: false,
  callId: null,
  peerDevice: null,
  pending: null, // eingehend: { offer, fromDevice, callId, ice: [] }
  pendingIce: [],
  expectIncoming: null,
  otherOnline: null,
  outgoingTimer: null,
  failTimer: null,
  lastTap: 0,
  sleep: { ava: false, romy: false }, // V1.01 Schlummermodus (vom Worker)
};

const ME_NAME = window.AVAROMY_SIDE?.meName || (SIDE.me === "ava" ? "Ava" : "Romy");

// ---------------------------------------------------------------------------
// Bildschirme

function show(el, on) {
  if (!el) return;
  el.hidden = !on;
}

function showScreen(name) {
  state.screen = name;
  for (const [k, el] of Object.entries(ui.screens)) show(el, k === name);
  ui.app.dataset.screen = name;
  setCallActive(name === "call");
  if (name === "home" || name === "incoming" || name === "call") requestLayout();
}

let toastTimer = null;
function toast(text, ms = 2600) {
  ui.toast.textContent = text;
  show(ui.toast, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(ui.toast, false), ms);
}

function goHome() {
  if (!state.config) {
    showScreen("code");
    return;
  }
  showScreen("home");
  updateHomeStatus();
}

function updateHomeStatus() {
  // Nur ein dezenter Hinweis für Erwachsene, wenn die Verbindung fehlt.
  const offline = state.config && !state.signaling.isOpen() && state.signaling.wanted;
  ui.homeStatus.textContent = offline ? "Keine Verbindung …" : "";
  show(ui.homeStatus, !!offline && state.screen === "home");
}

// ---------------------------------------------------------------------------
// Foto: ganzer Bildschirm, Gesicht mittig (Quer- und Hochformat-Zuschnitt)

function viewSize() {
  const r = ui.app.getBoundingClientRect();
  return { w: r.width || window.innerWidth, h: r.height || window.innerHeight };
}

export function coverPlacement(viewW, viewH, imgW, imgH, focus, target = { x: 0.5, y: 0.45 }) {
  const s = Math.max(viewW / imgW, viewH / imgH);
  const dw = imgW * s;
  const dh = imgH * s;
  let left = viewW * target.x - focus.x * dw;
  let top = viewH * target.y - focus.y * dh;
  left = Math.min(0, Math.max(viewW - dw, left));
  top = Math.min(0, Math.max(viewH - dh, top));
  return { left, top, width: dw, height: dh };
}

function placePhotos() {
  if (!state.photoUrls.landscape) return;
  const { w, h } = viewSize();
  if (!w || !h) return;
  const orient = w >= h ? "landscape" : "portrait";
  const meta = state.photoMeta[orient];
  const url = state.photoUrls[orient];
  state.orient = orient;
  const p = coverPlacement(w, h, meta.w, meta.h, meta.focus);
  for (const img of ui.photos) {
    if (img.getAttribute("src") !== url) img.src = url;
    img.dataset.orient = orient;
    img.style.setProperty("--focus-x", `${meta.focus.x * 100}%`);
    img.style.setProperty("--focus-y", `${meta.focus.y * 100}%`);
    img.style.left = `${p.left}px`;
    img.style.top = `${p.top}px`;
    img.style.width = `${p.width}px`;
    img.style.height = `${p.height}px`;
    img.classList.add("is-placed");
  }
}

let layoutTimer = null;
let layoutTimerLate = null;
function requestLayout() {
  updateViewportFix();
  placePhotos();
  clearTimeout(layoutTimer);
  clearTimeout(layoutTimerLate);
  layoutTimer = setTimeout(() => { updateViewportFix(); placePhotos(); }, 50);
  // iOS meldet nach dem Drehen oft erst nach der Animation die echten Maße.
  layoutTimerLate = setTimeout(() => { updateViewportFix(); placePhotos(); }, 300);
}

window.addEventListener("resize", requestLayout);
window.addEventListener("orientationchange", () => { requestLayout(); setTimeout(requestLayout, 350); });
window.addEventListener("pageshow", requestLayout);
window.visualViewport?.addEventListener("resize", requestLayout);

// ---- iOS-Home-Bildschirm-Viewport (aus Hannafon V1.05/V1.07) ----------------
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true;
}

function computeIosBottomGap({ standalone, screenW, screenH, innerW, innerH, safeTop }) {
  if (!standalone) return 0;
  if (!(screenW > 0 && screenH > 0 && innerW > 0 && innerH > 0)) return 0;
  const long = Math.max(screenW, screenH);
  const short = Math.min(screenW, screenH);
  const landscape = innerW > innerH;
  const fullW = landscape ? long : short;
  const fullH = landscape ? short : long;
  if (Math.abs(innerW - fullW) > 2) return 0;
  const gap = Math.round(fullH - innerH);
  if (gap < 8 || gap > 80) return 0;
  if (!(safeTop >= 8) || Math.abs(gap - safeTop) > 3) return 0;
  return gap;
}

let safeProbe = null;
function readSafeTop() {
  if (!safeProbe) {
    safeProbe = document.createElement("div");
    safeProbe.setAttribute("aria-hidden", "true");
    safeProbe.style.cssText =
      "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)";
    document.body.appendChild(safeProbe);
  }
  return safeProbe.getBoundingClientRect().height || 0;
}

function updateViewportFix() {
  const t = window.__AVAROMY_VIEWPORT_TEST__ || {};
  const standalone = Boolean(t.standalone ?? isStandalone());
  const gap = computeIosBottomGap({
    standalone,
    screenW: t.screenW ?? window.screen?.width,
    screenH: t.screenH ?? window.screen?.height,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    safeTop: t.safeTop ?? readSafeTop(),
  });
  const root = document.documentElement;
  root.classList.toggle("is-standalone", standalone);
  root.style.setProperty("--ios-gap", `${gap}px`);
  root.dataset.orient = window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

// ---------------------------------------------------------------------------
// Code + Konfiguration

async function loadPhotos() {
  const side = state.config.sides?.[SIDE.other];
  if (!side?.photos) throw new Error("Foto fehlt");
  const webpOk = document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
  for (const orient of ["landscape", "portrait"]) {
    const v = side.photos[orient];
    state.photoMeta[orient] = { w: v.w, h: v.h, focus: v.focus || { x: 0.5, y: 0.45 } };
    state.photoUrls[orient] = await mediaUrl(state.code, webpOk ? v.webp : v.jpg);
  }
  placePhotos();
  await Promise.all(ui.photos.map((img) => img.decode?.().catch(() => {})));
}

function consumeInviteCode() {
  const url = new URL(location.href);
  const raw = url.searchParams.get("code") || "";
  if (raw) {
    url.searchParams.delete("code");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
  return raw;
}

function incomingFromUrl() {
  const url = new URL(location.href);
  const inc = url.searchParams.get("incoming");
  if (inc) {
    url.searchParams.delete("incoming");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
  return inc === SIDE.other;
}

async function afterAuth(cfg, code) {
  state.config = cfg;
  state.code = normalizeCode(code);
  localStorage.setItem(STORAGE_CODE, state.code);
  applySleep(cfg.sleep);
  await loadPhotos();
  // Kinder-iPads: wie Hannas iPad – Keep-Alive immer erlaubt, Bildschirm wach.
  setKeepAliveAllowed(true);
  syncWakeLock();
  connectSignaling();
  const incoming = incomingFromUrl();
  goHome();
  if (incoming) expectIncoming();
  refreshPushUi().catch(() => {});
}

async function tryStoredCode() {
  updateViewportFix();
  const stored = localStorage.getItem(STORAGE_CODE) || "";
  const invite = consumeInviteCode();
  const code = invite || stored;
  show(ui.codeInstallHint, !isStandalone());
  if (!code) {
    showScreen("code");
    return;
  }
  try {
    const cfg = stored && !invite ? await loadConfig(code) : await auth(code);
    await afterAuth(cfg, code);
  } catch (err) {
    if (err?.status === 401 || invite || /Code/.test(err?.message || "")) {
      localStorage.removeItem(STORAGE_CODE);
      showScreen("code");
      if (invite) {
        ui.codeError.textContent = "Der Code im Link stimmt nicht.";
        show(ui.codeError, true);
      }
      return;
    }
    // Kein Netz: Code behalten, später erneut versuchen.
    showScreen("loading");
    setTimeout(tryStoredCode, 5000);
  }
}

ui.codeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  show(ui.codeError, false);
  const raw = ui.codeInput.value;
  try {
    const cfg = await auth(raw);
    ui.codeInput.value = "";
    ui.codeInput.blur();
    primeMediaPermission("setup");
    await afterAuth(cfg, raw);
  } catch (err) {
    ui.codeError.textContent = err.message || "Der Code stimmt nicht.";
    show(ui.codeError, true);
  }
});

// ---------------------------------------------------------------------------
// Signalisierung

function connectSignaling() {
  const s = state.signaling;
  s.on("call", onRemoteCall);
  s.on("answer", onRemoteAnswer);
  s.on("ice", onRemoteIce);
  s.on("hangup", onRemoteHangup);
  s.on("declined", onRemoteDeclined);
  s.on("taken", onTakenElsewhere);
  s.on("callee-offline", onCalleeOffline);
  s.on("callee-ringing", onCalleeRinging);
  s.on("sleep-state", (d) => applySleep(d.sleep));
  s.on("callee-sleeping", (d) => {
    applySleep(d.sleep);
    if (state.outgoing && !state.connected) {
      hangup(true);
      toast(`${OTHER_NAME} schläft`);
    }
  });
  s.on("presence", (d) => {
    state.otherOnline = !!d.otherOnline;
    updateHomeStatus();
    if (!ui.sheet.hidden) paintSettings();
  });
  s.connect(state.code, SIDE.me, getDeviceId());
}

setInterval(updateHomeStatus, 3000);

function expectIncoming() {
  if (state.pending || state.inCall) return;
  state.expectIncoming = { until: Date.now() + EXPECT_INCOMING_MS };
  state.signaling.reconnect();
  clearTimeout(state.expectTimer);
  state.expectTimer = setTimeout(() => {
    if (!state.expectIncoming) return;
    state.expectIncoming = null;
    if (!state.pending && !state.inCall) toast("Anruf vorbei");
  }, EXPECT_INCOMING_MS);
}

function expecting() {
  return !!(state.expectIncoming && Date.now() < state.expectIncoming.until);
}

function endExpect() {
  state.expectIncoming = null;
  clearTimeout(state.expectTimer);
}

// ---------------------------------------------------------------------------
// Anrufen (Foto antippen)

function onPhotoTap() {
  if (anySleeping()) return; // Schlummermodus: kein Anruf
  const now = Date.now();
  if (now - state.lastTap < 900) return; // Kleinkind tippt mehrfach
  state.lastTap = now;
  // Kamera/Mikro direkt im Tipp anfragen (iOS), Ton entsperren.
  primeMediaPermission("tap");
  unlockAudio(true);
  ui.photoBtn.classList.add("is-pressed");
  setTimeout(() => ui.photoBtn.classList.remove("is-pressed"), 160);
  startCall();
}

ui.photoBtn.addEventListener("click", onPhotoTap);

function peerHandlers() {
  return {
    onIce: (candidate) =>
      state.signaling.send({ type: "ice", toDevice: state.peerDevice || undefined, fromDevice: getDeviceId(), candidate }),
    onTrack: (stream) => {
      state.remoteStream = stream;
      ui.remoteVideo.srcObject = stream;
      ui.remoteVideo.play().catch(() => {});
    },
    onState: (s) => {
      if (s === "connected") {
        clearTimeout(state.failTimer);
        state.connected = true;
        ui.screens.call.classList.add("is-connected");
        ui.callStatus.textContent = "";
        if (state.pc) applySendCaps(state.pc, 1);
      } else if (s === "failed" || s === "disconnected") {
        ui.screens.call.classList.remove("is-connected");
        ui.callStatus.textContent = "Verbindung unterbrochen …";
        clearTimeout(state.failTimer);
        state.failTimer = setTimeout(() => {
          if (state.pc && state.pc.connectionState !== "connected") hangup(false);
        }, s === "failed" ? 4000 : 15000);
      }
    },
  };
}

async function startCall() {
  if (!state.config) return;
  if (state.inCall) return;
  if (anySleeping()) return;
  // Die andere Seite ruft gerade an: annehmen statt zurückrufen.
  if (state.pending) {
    acceptIncoming();
    return;
  }
  if (expecting()) {
    state.signaling.reconnect();
    return;
  }
  state.inCall = true;
  state.outgoing = true;
  state.connected = false;
  state.callId = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}`;
  state.peerDevice = null;
  ui.screens.call.classList.remove("is-connected");
  ui.callStatus.textContent = `${OTHER_NAME} wird angerufen …`;
  delete ui.callStatus.dataset.offline;
  showScreen("call");
  clearTimeout(state.outgoingTimer);
  state.outgoingTimer = setTimeout(() => {
    if (state.outgoing && !state.connected && !state.pc?.remoteDescription) {
      hangup(false);
      toast(`${OTHER_NAME} hat nicht abgenommen`);
    }
  }, OUTGOING_RING_MS);
  const callId = state.callId;
  try {
    const stream = await getLocalStream();
    if (state.callId !== callId) {
      stopStream(stream);
      return;
    }
    state.localStream = stream;
    ui.localVideo.srcObject = stream;
    // Lokale Referenz: wird der Versuch verworfen (gleichzeitig getippt),
    // darf diese Funktion den neuen Anruf nicht anfassen.
    const pc = createPeer(state.config.iceServers, stream, peerHandlers());
    state.pc = pc;
    const offer = await pc.createOffer();
    if (state.callId !== callId) return closePeer(pc);
    await pc.setLocalDescription(offer);
    if (state.callId !== callId) return closePeer(pc);
    applySendCaps(pc, 1);
    state.signaling.send({
      type: "call",
      fromDevice: getDeviceId(),
      fromName: window.AVAROMY_SIDE?.meName || "",
      callId,
      sdp: pc.localDescription,
    });
  } catch {
    if (state.callId === callId) ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
}

function onCalleeOffline(data) {
  if (!state.outgoing || state.connected || (data.callId && data.callId !== state.callId)) return;
  ui.callStatus.textContent = `${OTHER_NAME} ist gerade nicht verbunden. Es klingelt, sobald ${SIDE.otherApp} wieder online ist.`;
  ui.callStatus.dataset.offline = "1";
}

function onCalleeRinging() {
  if (!state.outgoing || state.connected || ui.callStatus.dataset.offline !== "1") return;
  delete ui.callStatus.dataset.offline;
  ui.callStatus.textContent = `${OTHER_NAME} wird angerufen …`;
}

async function onRemoteAnswer(data) {
  if (!state.pc || !data.sdp || !state.outgoing) return;
  if (state.pc.remoteDescription) return;
  clearTimeout(state.outgoingTimer);
  state.peerDevice = data.fromDevice || null;
  delete ui.callStatus.dataset.offline;
  ui.callStatus.textContent = "Verbinden …";
  await state.pc.setRemoteDescription(data.sdp);
  await flushIce(state.pc);
}

function onRemoteDeclined() {
  if (!state.outgoing || state.connected) return;
  hangup(true);
  toast(`${OTHER_NAME} kann gerade nicht`);
}

// ---------------------------------------------------------------------------
// Eingehender Anruf

function onRemoteCall(data) {
  if (!data?.sdp) return;
  if (state.sleep[SIDE.me]) return; // schlafend: nie klingeln
  if (state.inCall && !state.outgoing) return; // schon im Gespräch
  if (state.inCall && state.connected) return;
  // Gleiches Angebot noch einmal (nach Neuverbinden): nur ICE ergänzen.
  if (state.pending && data.callId && data.callId === state.pending.callId) {
    for (const c of data.ice || []) queueIce(c);
    endExpect();
    return;
  }
  // Beide haben gleichzeitig getippt: eigenen Versuch still verwerfen und annehmen.
  const glare = state.outgoing;
  if (glare) dropLocalCall();
  endExpect();
  state.pending = { offer: data.sdp, fromDevice: data.fromDevice || null, callId: data.callId || null };
  state.pendingIce = [];
  for (const c of data.ice || []) queueIce(c);
  ui.incomingTitle.textContent = `${OTHER_NAME} ruft an`;
  showScreen("incoming");
  beginRing();
  // Hat dieses Gerät gerade selbst angerufen (gleichzeitig getippt), sofort verbinden.
  if (glare) acceptIncoming();
}

async function beginRing() {
  await startRingtone();
  updateRingHint();
}

function updateRingHint() {
  // „Tippen zum Annehmen“ steht immer da; ohne hörbaren Ton pulsiert es stärker.
  const locked = !isRingAudible();
  ui.screens.incoming.classList.toggle("is-waiting-audio", locked && state.screen === "incoming");
}

function queueIce(c) {
  if (!c) return;
  if (state.pendingIce.length < 60) state.pendingIce.push(c);
}

async function onRemoteIce(data) {
  if (!data.candidate) return;
  if (!state.pc && state.pending) {
    queueIce(data.candidate);
    return;
  }
  if (state.pc) await addIce(state.pc, data.candidate);
}

ui.screens.incoming.addEventListener("click", (ev) => {
  if (ev.target.closest("#btn-decline")) return;
  acceptIncoming();
});

async function acceptIncoming() {
  const p = state.pending;
  if (!p) return;
  stopRingtone();
  unlockAudio(true);
  ui.screens.incoming.classList.remove("is-waiting-audio");
  state.pending = null;
  state.inCall = true;
  state.outgoing = false;
  state.connected = false;
  state.callId = p.callId;
  state.peerDevice = p.fromDevice;
  ui.screens.call.classList.remove("is-connected");
  ui.callStatus.textContent = "Verbinden …";
  showScreen("call");
  const callId = p.callId;
  try {
    const stream = await getLocalStream();
    if (state.callId !== callId || !state.inCall) return stopStream(stream);
    state.localStream = stream;
    ui.localVideo.srcObject = stream;
    const pc = createPeer(state.config.iceServers, stream, peerHandlers());
    state.pc = pc;
    await pc.setRemoteDescription(p.offer);
    for (const c of state.pendingIce) await addIce(pc, c);
    state.pendingIce = [];
    await flushIce(pc);
    const answer = await pc.createAnswer();
    if (state.pc !== pc) return;
    await pc.setLocalDescription(answer);
    if (state.pc !== pc) return;
    applySendCaps(pc, 1);
    state.signaling.send({
      type: "answer",
      toDevice: p.fromDevice || undefined,
      fromDevice: getDeviceId(),
      callId: p.callId || undefined,
      sdp: pc.localDescription,
    });
  } catch {
    if (state.callId === callId) ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
}

ui.btnDecline.addEventListener("click", (ev) => {
  ev.stopPropagation();
  stopRingtone();
  if (state.pending) state.signaling.send({ type: "reject", callId: state.pending.callId || undefined });
  state.pending = null;
  state.pendingIce = [];
  goHome();
});

function onTakenElsewhere() {
  if (state.inCall) return;
  stopRingtone();
  state.pending = null;
  goHome();
}

function onRemoteHangup() {
  if (state.pending && !state.inCall) {
    // Anrufer hat aufgegeben, während es klingelte.
    stopRingtone();
    state.pending = null;
    state.pendingIce = [];
    goHome();
    return;
  }
  if (state.inCall) hangup(true);
}

// ---------------------------------------------------------------------------
// Auflegen

function dropLocalCall() {
  clearTimeout(state.outgoingTimer);
  closePeer(state.pc);
  state.pc = null;
  stopStream(state.localStream);
  state.localStream = null;
  ui.localVideo.srcObject = null;
  state.inCall = false;
  state.outgoing = false;
  state.callId = null;
  state.peerDevice = null;
}

function hangup(remote) {
  stopRingtone();
  clearTimeout(state.outgoingTimer);
  clearTimeout(state.failTimer);
  if (!remote && state.inCall) {
    state.signaling.send({ type: "hangup", fromDevice: getDeviceId(), callId: state.callId || undefined });
  }
  closePeer(state.pc);
  state.pc = null;
  stopStream(state.localStream);
  state.localStream = null;
  state.remoteStream = null;
  ui.localVideo.srcObject = null;
  ui.remoteVideo.srcObject = null;
  ui.screens.call.classList.remove("is-connected");
  ui.callStatus.textContent = "";
  state.inCall = false;
  state.outgoing = false;
  state.connected = false;
  state.callId = null;
  state.peerDevice = null;
  state.pending = null;
  state.pendingIce = [];
  goHome();
}

ui.btnHangup.addEventListener("click", (ev) => {
  ev.stopPropagation();
  hangup(false);
});

// ---------------------------------------------------------------------------
// V1.01 Schlummermodus: Mond-Knopf schaltet die eigene Seite schlafen. Die
// andere App zeigt dann „Ava schläft“ und kann nicht anrufen (der Worker
// lehnt Anrufe an eine schlafende Seite ab: kein Klingeln, kein Push).

function anySleeping() {
  return !!(state.sleep[SIDE.me] || state.sleep[SIDE.other]);
}

function applySleep(sleep) {
  if (!sleep) return;
  state.sleep = { ava: !!sleep.ava, romy: !!sleep.romy };
  const me = state.sleep[SIDE.me];
  const other = state.sleep[SIDE.other];
  const home = ui.screens.home;
  home.classList.toggle("is-me-sleeping", me);
  home.classList.toggle("is-other-sleeping", other && !me);
  show(ui.night, me);
  show(ui.otherSleep, other && !me);
  ui.photoBtn.disabled = me || other;
  ui.photoBtn.setAttribute("aria-label", me ? "Schlummermodus" : other ? `${OTHER_NAME} schläft` : `${OTHER_NAME} anrufen`);
  ui.btnSleep.setAttribute("aria-pressed", me ? "true" : "false");
  ui.btnSleep.setAttribute("aria-label", me ? "Aufwachen (Schlummermodus aus)" : "Schlummermodus einschalten");
  // Klingelt es gerade bei mir und ich schlafe jetzt: aufhören.
  if (me && state.pending && !state.inCall) {
    stopRingtone();
    state.pending = null;
    state.pendingIce = [];
    goHome();
  }
  // Ich rufe gerade an und die andere Seite schläft jetzt ein: abbrechen.
  if ((other || me) && state.outgoing && !state.connected && !state.pc?.remoteDescription) {
    hangup(false);
    if (other) toast(`${OTHER_NAME} schläft`);
  }
  syncWakeLock();
  if (!ui.sheet.hidden) paintSettings();
}

ui.btnSleep.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const on = !state.sleep[SIDE.me];
  unlockAudio(true);
  applySleep({ ...state.sleep, [SIDE.me]: on }); // sofort anzeigen, Worker bestätigt
  state.signaling.send({ type: "sleep", on });
});

// ---------------------------------------------------------------------------
// Bildschirm wach halten (wie Hannas iPad)

let wakeLock = null;
async function syncWakeLock() {
  // Im Schlummermodus darf das iPad den Bildschirm ausschalten.
  const want = document.visibilityState === "visible" && !!state.config && !!navigator.wakeLock && !state.sleep[SIDE.me];
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch {
      wakeLock = null;
    }
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
}
document.addEventListener("pointerdown", () => { if (!wakeLock) syncWakeLock(); }, { passive: true });

// Zurück aus dem Hintergrund: neu verbinden, damit ein klingelnder Anruf ankommt.
function revive() {
  if (document.visibilityState !== "visible") return;
  syncWakeLock();
  requestLayout();
  if (state.config && !state.inCall) state.signaling.reconnect();
}
document.addEventListener("visibilitychange", revive);
window.addEventListener("pageshow", (ev) => { if (ev.persisted) revive(); });

// ---------------------------------------------------------------------------
// Web Push

function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

async function subscribePush() {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (Notification.permission !== "granted") return { ok: false, reason: Notification.permission };
  const vapid = state.config?.vapidPublicKey;
  if (!vapid) return { ok: false, reason: "no-vapid" };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid) });
  }
  const ok = await postSubscribe(state.code, SIDE.me, sub.toJSON(), getDeviceId());
  return { ok, reason: ok ? "active" : "post-failed" };
}

let pushState = { label: "–", subscribed: false };
async function refreshPushUi() {
  let label = "nicht verfügbar";
  let subscribed = false;
  if (pushSupported()) {
    if (Notification.permission === "granted") {
      try { subscribed = !!(await subscribePush()).ok; } catch { subscribed = false; }
      label = subscribed ? "aktiv" : "nicht aktiv";
    } else if (Notification.permission === "denied") {
      label = "blockiert (iPad-Einstellungen)";
    } else {
      label = "nicht erlaubt";
    }
  }
  pushState = { label, subscribed };
  paintSettings();
}

ui.btnNotify.addEventListener("click", async () => {
  // Erlaubnis nur direkt im Tipp (iOS).
  try {
    if (!pushSupported()) return;
    await Notification.requestPermission();
  } catch {
    /* ignore */
  }
  await refreshPushUi();
});

ui.btnPushTest.addEventListener("click", async () => {
  const res = await postPushTest(state.code, { deviceId: getDeviceId(), side: SIDE.me }).catch(() => ({ ok: false }));
  ui.stPush.textContent = res.ok ? "Test gesendet" : "Test fehlgeschlagen";
});

// ---------------------------------------------------------------------------
// Versteckte Einstellungen: oben links 3 s gedrückt halten

const HOLD_MS = 3000;
let holdTimer = null;
let holdShowTimer = null;
function cancelHold() {
  clearTimeout(holdTimer);
  clearTimeout(holdShowTimer);
  holdTimer = holdShowTimer = null;
  show(ui.settingsProgress, false);
}
ui.hotspot.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  cancelHold();
  holdShowTimer = setTimeout(() => show(ui.settingsProgress, true), 800);
  holdTimer = setTimeout(() => {
    cancelHold();
    openSettings();
  }, HOLD_MS);
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) ui.hotspot.addEventListener(ev, cancelHold);
ui.hotspot.addEventListener("click", (ev) => ev.stopPropagation());
ui.hotspot.addEventListener("contextmenu", (ev) => ev.preventDefault());

function paintSettings() {
  ui.stConn.textContent = state.signaling.isOpen() ? "verbunden" : "nicht verbunden";
  ui.stOther.textContent = state.otherOnline == null ? "–" : state.otherOnline ? "online" : "nicht verbunden";
  ui.stPush.textContent = pushState.label;
  const supported = pushSupported();
  show(ui.btnNotify, supported && Notification.permission === "default");
  show(ui.btnPushTest, pushState.subscribed);
  show(ui.installHint, !isStandalone());
  ui.btnReset.textContent = "Code neu eingeben";
  delete ui.btnReset.dataset.armed;
  show(ui.btnReset, !!state.config);
}

function openSettings() {
  paintSettings();
  show(ui.sheet, true);
  refreshPushUi().catch(() => {});
  refreshMediaPermissionState();
}

ui.btnSettingsClose.addEventListener("click", () => show(ui.sheet, false));
ui.sheet.addEventListener("click", (ev) => {
  if (ev.target === ui.sheet) show(ui.sheet, false);
});

ui.btnReset.addEventListener("click", async () => {
  if (!ui.btnReset.dataset.armed) {
    ui.btnReset.dataset.armed = "1";
    ui.btnReset.textContent = "Wirklich? Nochmal tippen";
    return;
  }
  await fullReset();
});

async function fullReset() {
  hangup(false);
  state.signaling.close();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (state.code) await postUnsubscribe(state.code, { endpoint: sub?.endpoint, deviceId: getDeviceId() });
    if (sub) await sub.unsubscribe();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(STORAGE_CODE);
  await clearMediaCache();
  location.reload();
}

// ---------------------------------------------------------------------------
// Kleinkindsicher: kein Zoom, kein Kontextmenü, kein Ziehen

(function toddlerProof() {
  const block = (ev) => ev.preventDefault();
  for (const ev of ["gesturestart", "gesturechange", "gestureend", "contextmenu", "dragstart", "selectstart"]) {
    document.addEventListener(ev, (e) => {
      if (ev === "selectstart" && e.target.closest?.("input")) return;
      block(e);
    }, { passive: false });
  }
  document.addEventListener("touchmove", (ev) => {
    if (!ev.target.closest?.(".sheet-card")) ev.preventDefault();
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (ev) => {
    const now = Date.now();
    if (now - lastTouchEnd < 350 && !ev.target.closest?.("input")) ev.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener("wheel", (ev) => { if (ev.ctrlKey) ev.preventDefault(); }, { passive: false });
})();

// ---------------------------------------------------------------------------
// Service Worker (Offline-Hülle, Push, Mitteilung → Anruf zustellen)

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type === "incoming" && ev.data.data?.incoming === SIDE.other) expectIncoming();
  });
  navigator.serviceWorker.startMessages?.();
}

bindAudioUnlock();
updateViewportFix();
tryStoredCode();

// Test-Hooks (nur lesend bzw. für E2E)
window.__avaromyTest = {
  version: VERSION,
  side: SIDE,
  screen: () => state.screen,
  ready: () => !!(state.config && ui.photos[0].naturalWidth),
  photoInfo: () => {
    const img = ui.photos[0];
    const r = img.getBoundingClientRect();
    const v = ui.app.getBoundingClientRect();
    return {
      orient: state.orient,
      img: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      view: { width: v.width, height: v.height, innerW: window.innerWidth, innerH: window.innerHeight },
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      focus: state.photoMeta[state.orient]?.focus || null,
    };
  },
  call: () => ({
    inCall: state.inCall,
    outgoing: state.outgoing,
    connected: state.connected,
    pending: !!state.pending,
    pc: state.pc ? state.pc.connectionState : null,
  }),
  remoteLive: () => {
    const s = ui.remoteVideo.srcObject;
    return !!(s && s.getVideoTracks().some((t) => t.readyState === "live"));
  },
  audio: () => ({ ctx: audioContextState(), ...audioDebug() }),
  signaling: () => state.signaling.debug(),
  otherOnline: () => state.otherOnline,
  sleep: () => ({ ...state.sleep }),
  openSettings: () => openSettings(),
  settingsOpen: () => !ui.sheet.hidden,
  pauseSignaling: () => state.signaling.pause(),
  resumeSignaling: () => state.signaling.resume(),
  coverPlacement,
};
