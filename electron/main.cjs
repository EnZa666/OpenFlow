"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, Tray } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createStore } = require("../src/store");
const providers = require("../src/providers");
const flow = require("../src/flow");
const audio = require("../src/audio");
const parakeet = require("../src/parakeet");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let mainWindow = null;
let overlayWindow = null;
let noteWindow = null;
let tray = null;
let chord = null;
let store = null;
let quitting = false;
let overlayTimer = null;
let dictating = false;
let dictateSource = "";
let pointerTimer = null;
let pointerNear = false;
let barMenuOpen = false;
let chordStarts = 0;
let targetHwnd = 0;
let notePadId = "";
let hidingBar = false;
let flameshotDaemon = null;
let pendingRefresh = null;
let speechChain = Promise.resolve();
const speechSessions = new Map();
const root = path.join(__dirname, "..");

function decodeChunk(chunk) {
  let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) buffer = buffer.subarray(2);
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

function takeLines(buffer, chunk) {
  const next = buffer + decodeChunk(chunk);
  const lines = next.split(/\r?\n/);
  return { buffer: lines.pop() || "", lines };
}

function sendBar(message) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const deliver = () => {
    if (!overlayWindow.isDestroyed()) overlayWindow.webContents.send("bar-command", message);
  };
  if (overlayWindow.webContents.isLoading()) overlayWindow.webContents.once("did-finish-load", deliver);
  else deliver();
}

function toggleDictate() {
  if (dictating) endDictate();
  else beginDictate();
}

function scriptCopy(name) {
  const target = path.join(app.getPath("userData"), name);
  fs.copyFileSync(path.join(__dirname, name), target);
  return target;
}

function unmuteMic() {
  if (process.platform !== "win32") return;
  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptCopy("unmute.ps1")], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function runPowershell(args) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => resolve(1));
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("exit", (code) => resolve(code == null ? 1 : code));
  });
}

let microphoneRepair = null;

function ensureMicrophone() {
  if (process.platform !== "win32" || process.env.OPENFLOW_SMOKE === "1") {
    return Promise.resolve({ ok: true, changed: false });
  }
  if (!microphoneRepair) {
    microphoneRepair = repairMicrophone().finally(() => {
      microphoneRepair = null;
    });
  }
  return microphoneRepair;
}

async function repairMicrophone() {
  try {
    const script = scriptCopy("micrepair.ps1");
    const detected = await runPowershell(["-File", script]);
    if (detected === 0) return { ok: true, changed: false };
    if (detected !== 10) return { ok: false, changed: false };
    const launcher = path.join(app.getPath("userData"), "micrepair-run.ps1");
    const quoted = script.replace(/'/g, "''");
    fs.writeFileSync(launcher, [
      "$script = '" + quoted + "'",
      "$arg = \"-NoProfile -ExecutionPolicy Bypass -File `\"$script`\" -Apply\"",
      "$proc = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $arg",
      "if ($null -eq $proc) { exit 1 }",
      "exit $proc.ExitCode",
      "",
    ].join("\r\n"));
    const applied = await runPowershell(["-File", launcher]);
    return { ok: applied === 0, changed: applied === 0 };
  } catch (_error) {
    return { ok: false, changed: false };
  }
}

function rememberTarget(hwnd) {
  const value = Number(hwnd);
  if (Number.isFinite(value) && value > 0) targetHwnd = value;
}

function beginDictate(hwnd, source) {
  const next = source === "symbol" ? "symbol" : "chord";
  if (dictating) {
    if (dictateSource === "symbol" && next === "chord") endDictate();
    return;
  }
  rememberTarget(hwnd);
  dictating = true;
  dictateSource = next;
  unmuteMic();
  sendBar({ type: "start", source: next });
}

function endDictate() {
  if (!dictating) return;
  const source = dictateSource;
  dictating = false;
  dictateSource = "";
  if (source === "symbol") pointerNear = false;
  sendBar({ type: "stop", source });
}

function needsKeyPrompt() {
  if (process.env.OPENFLOW_SMOKE === "1" || !store) return false;
  const settings = store.getSettings();
  return settings.sttEngine === "openai" && !readKey();
}

function needsOnboarding() {
  if (process.env.OPENFLOW_SMOKE === "1" || !store) return false;
  return !store.getSettings().onboardingDone;
}

function syncSttEngine() {
  if (!store || process.env.OPENFLOW_SMOKE === "1") return;
  const settings = store.getSettings();
  if (settings.sttEngine === "openai") {
    parakeet.stopBackground();
  } else {
    parakeet.startBackground(app.getPath("userData")).catch(() => {});
  }
}

function showMain(refresh) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  const payload = { ...(refresh || {}) };
  if (needsOnboarding()) payload.onboarding = true;
  else if (needsKeyPrompt()) payload.askKey = true;
  pendingRefresh = payload;
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("desk-refresh", pendingRefresh || {});
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

function placeBar(width, height) {
  if (hidingBar) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const safeWidth = Math.max(56, Math.min(420, Math.round(Number(width) || 72)));
  const safeHeight = Math.max(18, Math.min(460, Math.round(Number(height) || 18)));
  const next = {
    x: Math.round(area.x + (area.width - safeWidth) / 2),
    y: Math.round(area.y + area.height - safeHeight - 12),
    width: safeWidth,
    height: safeHeight,
  };
  const current = overlayWindow.getBounds();
  if (current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height) return;
  overlayWindow.setBounds(next);
}

function sendNotePad() {
  if (!noteWindow || noteWindow.isDestroyed() || !notePadId) return;
  const deliver = () => {
    if (!noteWindow || noteWindow.isDestroyed() || !notePadId) return;
    noteWindow.webContents.send("note-show", { id: notePadId });
  };
  if (noteWindow.webContents.isLoading()) noteWindow.webContents.once("did-finish-load", deliver);
  else deliver();
}

function showNotePad(id) {
  notePadId = id || "";
  if (noteWindow && !noteWindow.isDestroyed()) {
    if (noteWindow.isMinimized()) noteWindow.restore();
    noteWindow.show();
    noteWindow.setAlwaysOnTop(true, "pop-up-menu");
    noteWindow.moveTop();
    noteWindow.focus();
    sendNotePad();
    return;
  }
  noteWindow = new BrowserWindow({
    width: 480,
    height: 540,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    title: "Note",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  noteWindow.on("closed", () => {
    noteWindow = null;
  });
  noteWindow.once("ready-to-show", () => {
    if (!noteWindow || noteWindow.isDestroyed()) return;
    noteWindow.show();
    noteWindow.setAlwaysOnTop(true, "pop-up-menu");
    noteWindow.moveTop();
    noteWindow.focus();
  });
  noteWindow.webContents.on("did-finish-load", sendNotePad);
  noteWindow.loadFile(path.join(root, "renderer", "note.html"));
  const area = screen.getPrimaryDisplay().workArea;
  noteWindow.setBounds({
    x: Math.round(area.x + (area.width - 480) / 2),
    y: Math.round(area.y + area.height - 540 - 88),
    width: 480,
    height: 540,
  });
}

function openFreshNote() {
  showMain({ newDraftPad: true });
  return { id: "", isDraft: true, title: "Note", content: "" };
}

async function runModelInstallerIfNeeded() {
  const userData = app.getPath("userData");
  if (process.env.OPENFLOW_SMOKE === "1" || parakeet.isModelInstalled(userData)) {
    return;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    center: true,
    show: false,
    title: "Installing open-source STT model",
    icon: path.join(root, "build", "icon.png"),
    backgroundColor: "#faf9f7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(root, "renderer", "model-install.html"));
  if (!win.isDestroyed()) {
    win.show();
    win.focus();
  }
  try {
    await parakeet.ensureModelFiles(userData, (progress) => {
      if (!win.isDestroyed()) {
        win.webContents.send("model-install-progress", progress);
      }
    });
  } catch (error) {
    if (!win.isDestroyed()) {
      win.webContents.send("model-install-progress", {
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(1800);
    }
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

function pipeName() {
  return `OpenFlowPaste-${process.pid}`;
}

function startChord() {
  if (process.platform !== "win32" || process.env.OPENFLOW_SMOKE === "1" || chordStarts >= 3) return;
  chordStarts += 1;
  chord = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptCopy("chord.ps1")], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      OPENFLOW_PIPE: pipeName(),
      OPENFLOW_LOG: path.join(app.getPath("userData"), "paste.log"),
    }),
  });
  let buffer = "";
  chord.stderr.on("data", () => {});
  chord.stdout.on("data", (chunk) => {
    const parsed = takeLines(buffer, chunk);
    buffer = parsed.buffer;
    for (const line of parsed.lines) {
      const text = line.trim();
      if (text.startsWith("focus ")) {
        if (!dictating) rememberTarget(text.slice(6));
      } else if (text.startsWith("dictate-down")) {
        beginDictate(text.slice("dictate-down".length), "chord");
      } else if (text === "dictate-up") {
        if (dictateSource !== "symbol") endDictate();
      }
    }
  });
  chord.on("exit", (code) => {
    chord = null;
    if (!quitting && code) setTimeout(startChord, 600);
  });
}

function watchPointer() {
  if (pointerTimer) clearInterval(pointerTimer);
  pointerTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || dictating) return;
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getPrimaryDisplay().workArea;
    const center = area.x + area.width / 2;
    const bottom = area.y + area.height;
    const reachX = pointerNear ? (barMenuOpen ? 156 : 86) : 44;
    const reachY = pointerNear ? (barMenuOpen ? 330 : 58) : 36;
    const hit = Math.abs(cursor.x - center) <= reachX && bottom - cursor.y <= reachY && bottom - cursor.y >= -18;
    if (hit === pointerNear) return;
    pointerNear = hit;
    if (!hit) barMenuOpen = false;
    sendBar({ type: hit ? "near" : "far" });
  }, 50);
}

function stopChord() {
  if (chord && !chord.killed) chord.kill();
  chord = null;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(root, "renderer", "tray.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("OpenFlow");
  const menu = Menu.buildFromTemplate([
    { label: "Listen", click: () => toggleDictate() },
    { label: "New Note", click: () => openFreshNote() },
    { label: "Open Window", click: () => showMain() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.on("click", () => showMain());
  tray.on("double-click", () => showMain());
  tray.on("right-click", () => tray.popUpContextMenu(menu));
}

function keyPath() {
  return path.join(app.getPath("userData"), "api-key.bin");
}

function readKey() {
  const file = keyPath();
  if (!fs.existsSync(file)) return "";
  try {
    const payload = fs.readFileSync(file);
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(payload);
    return payload.toString("utf8");
  } catch (_error) {
    return "";
  }
}

function writeKey(value) {
  const file = keyPath();
  const text = String(value || "");
  if (!text) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(text, "utf8");
  fs.writeFileSync(file, payload);
}

function publicSettings() {
  const settings = store.getSettings();
  const preset = providers.defaultsFor(settings.provider);
  const sttEngine = settings.sttEngine === "openai" ? "openai" : "parakeet";
  return {
    ...settings,
    sttEngine,
    onboardingDone: Boolean(settings.onboardingDone),
    hasKey: Boolean(readKey()),
    parakeet: parakeet.getStatus(app.getPath("userData")),
    effective: {
      sttModel: settings.sttModel || preset.sttModel,
      ttsModel: settings.ttsModel || preset.ttsModel,
      ttsVoice: settings.ttsVoice || preset.ttsVoice,
      textModel: settings.textModel || preset.textModel,
      voices: preset.voices,
    },
  };
}

function sendOverlay(state) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  clearTimeout(overlayTimer);
  const mode = !state || !state.mode || state.mode === "hidden" ? "idle" : state.mode;
  const next = { ...state, mode, sounds: true };
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  const deliver = () => {
    if (!overlayWindow.isDestroyed()) overlayWindow.webContents.send("overlay-state", next);
  };
  if (overlayWindow.webContents.isLoading()) overlayWindow.webContents.once("did-finish-load", deliver);
  else deliver();
  if (mode === "result" || mode === "error") {
    overlayTimer = setTimeout(() => sendOverlay({ mode: "idle" }), 1400);
  }
}

function library() {
  return {
    corrections: store.listCorrections(),
    dictionary: store.listDictionary(),
    automations: store.listAutomations(),
  };
}

async function completeChat(requestFactory) {
  const request = requestFactory({
    provider: "openai",
    apiKey: readKey(),
  });
  const body = await providers.postJson(fetch, request);
  return providers.parseChatText(body);
}

const polishStyles = {
  concise: "more concise, same meaning",
  clarity: "clear written language, remove filler words",
  reorder: "same statements in a more readable order",
  structure: "same meaning, structured with paragraphs or lists where helpful",
  tone: "same meaning and tone, cleanly written",
};

async function applyTransform(text, kind) {
  if (kind === "prompt") {
    return completeChat((base) => providers.instructRequest({
      ...base,
      prompt: "Turn the spoken input into a clear prompt. Organize intent, context, and desired outcome. Return only the prompt.",
      context: text,
    }));
  }
  const style = polishStyles[store.getSettings().polishStyle] || polishStyles.clarity;
  return completeChat((base) => providers.rewriteRequest({
    ...base,
    text,
    style,
  }));
}

async function translateText(text, targetLanguage) {
  const output = await completeChat((base) => providers.translationRequest({
    ...base,
    text,
    targetLanguage: targetLanguage || store.getSettings().targetLanguage,
  }));
  store.addTranslation({ source_text: text, output_text: output, target_language: targetLanguage || store.getSettings().targetLanguage });
  return output;
}

let pasteChain = Promise.resolve();

function waitUntilListeningStops() {
  if (!dictating) return Promise.resolve();
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!dictating || Date.now() - started > 120000) {
        clearInterval(timer);
        resolve();
      }
    }, 40);
  });
}

function pasteLog(line) {
  try {
    const file = path.join(app.getPath("userData"), "paste.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch (error) {
    console.error(error);
  }
}

function pasteWithScript(text) {
  return new Promise((resolve) => {
    pasteLog(`fallback hwnd=${targetHwnd || 0} chars=${String(text).length}`);
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptCopy("paste.ps1"),
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, {
        OPENFLOW_PASTE_HWND: String(targetHwnd || 0),
        OPENFLOW_PASTE_B64: Buffer.from(String(text), "utf8").toString("base64"),
        OPENFLOW_LOG: path.join(app.getPath("userData"), "paste.log"),
      }),
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("error");
    }, 8000);
    child.stdout.on("data", (chunk) => {
      buffer += decodeChunk(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("error");
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const line = buffer.trim();
      if (line === "ok") resolve("ok");
      else if (line === "miss") resolve("miss");
      else resolve("error");
    });
  });
}

function askPipeOnce(text) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = net.connect(`\\\\.\\pipe\\${pipeName()}`);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("error"), 8000);
    socket.on("connect", () => {
      const payload = Buffer.from(String(text), "utf8").toString("base64");
      socket.write(`paste ${targetHwnd || 0} ${payload}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += decodeChunk(chunk);
      const line = buffer.trim();
      if (line.startsWith("ok")) finish("ok");
      else if (line.startsWith("miss")) finish("miss");
    });
    socket.on("error", () => finish("error"));
    socket.on("end", () => {
      const line = buffer.trim();
      if (line.startsWith("ok")) finish("ok");
      else if (line.startsWith("miss")) finish("miss");
      else finish("error");
    });
  });
}

function saveTranscriptNote(text) {
  const body = String(text || "").trim();
  const created = store.savePad({ title: "Note", content: body });
  store.addNotification({ title: "Note", body: "No text field focused — saved as note" });
  showMain({ openPadId: created.id });
  return created;
}

function pasteText(text) {
  const value = String(text || "");
  if (!value.trim()) return Promise.resolve();
  const typed = /\s$/.test(value) ? value : `${value} `;
  const run = pasteChain.then(async () => {
    await waitUntilListeningStops();
    clipboard.writeText(typed);
    if (process.platform !== "win32") return;
    let outcome = "error";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      outcome = await askPipeOnce(typed);
      pasteLog(`pipe hwnd=${targetHwnd || 0} attempt=${attempt} ${outcome}`);
      if (outcome !== "error") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (outcome === "error") outcome = await pasteWithScript(typed);
    pasteLog(`result ${outcome}`);
    if (outcome !== "ok") saveTranscriptNote(value);
  });
  pasteChain = run.then(() => {}, () => {});
  return run;
}

function audioBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && Array.isArray(value.data)) return Buffer.from(value.data);
  if (Array.isArray(value)) return Buffer.from(value);
  throw new Error("Recording is unreadable.");
}

function enqueueSpeech(work) {
  const run = speechChain.then(work, work);
  speechChain = run.then(() => {}, () => {});
  return run;
}

function openSpeechSession() {
  const token = crypto.randomUUID();
  const now = Date.now();
  for (const [key, session] of speechSessions) {
    if (now - session.created > 6 * 60 * 60 * 1000) speechSessions.delete(key);
  }
  speechSessions.set(token, {
    created: now,
    texts: [],
    language: "",
    pending: Promise.resolve(),
    failed: null,
  });
  return { token };
}

async function commitTranscript(raw, prepared, meta) {
  store.touchDictionary(prepared.usedPhrases, "used");
  let text = prepared.text;
  const history = store.addHistory({
    asr_text: raw,
    formatted_text: text,
    language: meta.language || "",
    app_name: meta.appName || "",
    url: meta.url || "",
    duration_ms: meta.durationMs || 0,
    word_count: flow.wordCount(text),
    status: "done",
  });
  for (const follow of prepared.followUps) {
    if (follow.type === "translate") {
      text = await translateText(text, follow.language);
      store.updateHistory(history.id, { formatted_text: text, word_count: flow.wordCount(text) });
    }
  }
  store.addNotification({ title: "Dictation saved", body: text.slice(0, 180) });
  if (meta.paste) await pasteText(text);
  return { raw, text, history, prepared };
}

function registerHotkey() {
  return true;
}

function createWindows() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 540,
    minWidth: 680,
    minHeight: 440,
    show: false,
    title: "OpenFlow",
    icon: path.join(root, "build", "icon.png"),
    backgroundColor: "#faf9f7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.loadFile(path.join(root, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (quitting || process.env.OPENFLOW_SMOKE === "1") return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("show", () => {
    if (process.env.OPENFLOW_SMOKE === "1") return;
    if (needsOnboarding()) {
      pendingRefresh = { ...(pendingRefresh || {}), onboarding: true };
    } else if (needsKeyPrompt()) {
      pendingRefresh = { ...(pendingRefresh || {}), askKey: true };
    } else {
      return;
    }
    const send = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("desk-refresh", pendingRefresh || {});
    };
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
    else send();
  });
  mainWindow.once("ready-to-show", () => {
    const smoke = process.env.OPENFLOW_SMOKE === "1";
    const openOnStart = smoke || needsOnboarding() || needsKeyPrompt() || process.argv.includes("--installed");
    if (openOnStart) mainWindow.show();
    if (!smoke && openOnStart) {
      showMain({
        onboarding: needsOnboarding(),
        askKey: !needsOnboarding() && needsKeyPrompt(),
      });
    }
  });
  if (process.env.OPENFLOW_SMOKE === "1") {
    const required = ["Dictation", "Notes", "Usage", "Settings"];
    mainWindow.webContents.on("did-fail-load", () => app.exit(1));
    mainWindow.webContents.on("did-finish-load", async () => {
      try {
        const text = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          const start = Date.now();
          const timer = setInterval(() => {
            const nav = document.querySelector("#nav");
            const value = nav ? nav.textContent : "";
            if (value.includes("Dictation") && value.includes("Settings")) {
              clearInterval(timer);
              resolve(value);
            } else if (Date.now() - start > 5000) {
              clearInterval(timer);
              resolve(value);
            }
          }, 50);
        })`);
        const missing = required.filter((label) => !String(text).includes(label));
        if (missing.length) {
          console.error(`SMOKE_MISSING ${missing.join(",")}`);
          app.exit(2);
          return;
        }
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
  }

  overlayWindow = new BrowserWindow({
    width: 72,
    height: 18,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow.webContents.setBackgroundThrottling(false);
  overlayWindow.loadFile(path.join(root, "renderer", "overlay.html"));
  overlayWindow.once("ready-to-show", () => {
    placeBar(72, 18);
    overlayWindow.showInactive();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreBar() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setOpacity(1);
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
}

function writeIniPairs(file, pairs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { text = ""; }
  const lines = text.split(/\r?\n/);
  let general = lines.findIndex((line) => line.trim().toLowerCase() === "[general]");
  if (general < 0) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[General]");
    general = lines.length - 1;
  }
  const wanted = new Map(Object.entries(pairs).map(([key, value]) => [key.toLowerCase(), [key, value]]));
  let sectionEnd = lines.length;
  for (let index = general + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[index]);
    if (!match) continue;
    const found = wanted.get(match[1].toLowerCase());
    if (!found) continue;
    lines[index] = `${found[0]}=${found[1]}`;
    wanted.delete(match[1].toLowerCase());
  }
  const insert = [];
  for (const [, pair] of wanted) insert.push(`${pair[0]}=${pair[1]}`);
  lines.splice(general + 1, 0, ...insert);
  fs.writeFileSync(file, `${lines.join("\r\n").replace(/\s+$/, "")}\r\n`);
}

function flameshotTheme() {
  return {
    uiColor: "#000000",
    contrastUiColor: "#ffffff",
    drawColor: "#000000",
    userColors: "#000000, #ffffff, #4d4d4d, #b3b3b3, #808080",
    showHelp: "false",
    showStartupLaunchMessage: "false",
    disabledTrayIcon: "true",
    checkForUpdates: "false",
    startupLaunch: "false",
    autoCloseIdleDaemon: "false",
    saveAfterCopy: "false",
    copyPathAfterSave: "false",
    useJpgForClipboard: "false",
  };
}

function writeFlameshotTheme(exe) {
  const files = [path.join(path.dirname(exe), "flameshot.ini")];
  if (process.env.APPDATA) files.push(path.join(process.env.APPDATA, "flameshot", "flameshot.ini"));
  for (const file of files) {
    try { writeIniPairs(file, flameshotTheme()); } catch { /* the other location can still apply */ }
  }
}

function flameshotAlive() {
  return Boolean(flameshotDaemon && flameshotDaemon.exitCode == null && !flameshotDaemon.killed);
}

function stopBundledFlameshot(exe) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, 4000);
    execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$want = [IO.Path]::GetFullPath($env:OF_FLAMESHOT); Get-CimInstance Win32_Process -Filter \"Name = 'flameshot.exe'\" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $want) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], {
      windowsHide: true,
      env: { ...process.env, OF_FLAMESHOT: exe },
    }, () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function ensureFlameshot(exe) {
  writeFlameshotTheme(exe);
  if (flameshotAlive()) return;
  await stopBundledFlameshot(exe);
  flameshotDaemon = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: path.dirname(exe),
  });
  flameshotDaemon.on("error", () => {});
  flameshotDaemon.unref();
  await delay(700);
}

function flameshotExe() {
  const roots = [
    path.join(process.resourcesPath, "flameshot"),
    path.join(root, "vendor", "flameshot", "flameshot-14.0.0-win64"),
  ];
  for (const base of roots) {
    const exe = path.join(base, "bin", "flameshot.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return "";
}

async function openFlameshot() {
  const exe = flameshotExe();
  if (!exe) {
    store.addNotification({ title: "Screenshot", body: "Flameshot missing" });
    return false;
  }
  await ensureFlameshot(exe);
  hidingBar = true;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  await delay(160);
  const child = spawn(exe, ["gui"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: path.dirname(exe),
  });
  child.unref();
  await delay(800);
  hidingBar = false;
  restoreBar();
  return true;
}

const actions = {
  "mic.repair": () => ensureMicrophone(),
  "settings.get": () => publicSettings(),
  "settings.save": (payload) => {
    if (payload && Object.prototype.hasOwnProperty.call(payload, "apiKey")) writeKey(payload.apiKey);
    const patch = { provider: "openai", sttModel: "", ttsModel: "", ttsVoice: "", textModel: "" };
    if (payload && (payload.sttEngine === "parakeet" || payload.sttEngine === "openai")) {
      patch.sttEngine = payload.sttEngine;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "onboardingDone")) {
      patch.onboardingDone = Boolean(payload.onboardingDone);
    }
    store.updateSettings(patch);
    syncSttEngine();
    return { settings: publicSettings(), hotkeyRegistered: true };
  },
  "transform.set": (payload) => {
    const kind = payload.transform === "prompt" ? "prompt" : "polish";
    const polishStyle = Object.prototype.hasOwnProperty.call(polishStyles, payload.polishStyle)
      ? payload.polishStyle
      : store.getSettings().polishStyle;
    store.updateSettings({
      transform: kind,
      transformAuto: Boolean(payload.transformAuto),
      polishStyle,
    });
    return publicSettings();
  },
  "dictate.toggle": (payload) => {
    if (dictating) endDictate();
    else beginDictate(targetHwnd, payload && payload.source === "symbol" ? "symbol" : "chord");
    return true;
  },
  "bar.mode": (payload) => {
    if (payload && Object.prototype.hasOwnProperty.call(payload, "menuOpen")) {
      barMenuOpen = Boolean(payload.menuOpen);
    }
    if (hidingBar) return true;
    placeBar(payload.width, payload.height);
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) overlayWindow.showInactive();
    return true;
  },
  "note.open": () => openFreshNote(),
  "shot.open": () => openFlameshot(),
  "note.close": () => {
    if (noteWindow && !noteWindow.isDestroyed()) noteWindow.hide();
    return true;
  },
  "desk.pending": () => {
    const value = pendingRefresh;
    pendingRefresh = null;
    return value || {};
  },
  "pads.list": () => store.listPads(),
  "pads.save": (payload) => store.savePad(payload || {}),
  "pads.delete": (payload) => {
    store.deletePad(payload.id);
    return true;
  },
  "speech.transform": async (payload) => ({ text: await applyTransform(payload.text, payload.kind || "polish") }),
  "desk.snapshot": () => ({
    settings: publicSettings(),
    dictionary: store.listDictionary(),
    history: store.listHistory(),
    pads: store.listPads(),
    usage: flow.usageReport(store.listHistory()),
    notes: store.listNotes(),
    meetings: store.listMeetings(),
    events: store.listEvents(),
    todos: store.listTodos(),
    folders: store.listFolders(),
    corrections: store.listCorrections(),
    links: store.listLinks(),
    automations: store.listAutomations(),
    polish: store.listPolish(),
    instruct: store.listInstruct(),
    translations: store.listTranslations(),
    notifications: store.listNotifications(),
    scratchpad: store.getScratchpad(),
    tour: flow.tourSteps(),
    stats: flow.computeStats(store.listHistory()),
  }),
  "dictionary.save": (payload) => store.upsertDictionary(payload),
  "dictionary.delete": (payload) => store.deleteDictionary(payload.phrase),
  "history.update": (payload) => store.updateHistory(payload.id, payload.patch || {}),
  "history.delete": (payload) => store.deleteHistory(payload.id),
  "notes.save": (payload) => store.saveNote(payload),
  "notes.versions": (payload) => store.listNoteVersions(payload.id),
  "notes.delete": (payload) => store.deleteNote(payload.id),
  "meetings.save": (payload) => store.saveMeeting(payload),
  "meetings.delete": (payload) => store.deleteMeeting(payload.id),
  "events.save": (payload) => store.saveEvent(payload),
  "events.delete": (payload) => store.deleteEvent(payload.id),
  "todos.save": (payload) => store.saveTodo(payload),
  "todos.delete": (payload) => store.deleteTodo(payload.id),
  "folders.save": (payload) => store.saveFolder(payload),
  "folders.delete": (payload) => store.deleteFolder(payload.id),
  "corrections.add": (payload) => store.addCorrection(payload),
  "corrections.delete": (payload) => store.deleteCorrection(payload.id),
  "links.save": (payload) => store.saveLink(payload),
  "links.delete": (payload) => store.deleteLink(payload.id),
  "links.open": async (payload) => {
    const url = new URL(payload.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web URLs are allowed.");
    await shell.openExternal(url.toString());
  },
  "automations.save": (payload) => store.saveAutomation(payload),
  "automations.delete": (payload) => store.deleteAutomation(payload.id),
  "scratchpad.set": (payload) => store.setScratchpad(payload.content),
  "notifications.read": (payload) => store.markNotification(payload.id),
  "notifications.add": (payload) => store.addNotification({
    title: payload.title || "Feedback",
    body: payload.body || "",
  }),
  "overlay.set": (payload) => {
    sendOverlay(payload);
    return true;
  },
  "clipboard.copy": (payload) => {
    clipboard.writeText(String(payload.text || ""));
    return true;
  },
  "clipboard.paste": (payload) => {
    pasteText(String(payload.text || ""));
    return true;
  },
  "text.prepare": async (payload) => {
    const raw = String(payload.text || "").trim();
    if (!raw) throw new Error("No text.");
    const prepared = flow.prepareTranscript(raw, library());
    return commitTranscript(raw, prepared, {
      appName: payload.appName,
      url: payload.url,
      durationMs: 0,
      paste: false,
      overlay: false,
    });
  },
  "speech.session": () => openSpeechSession(),
  "speech.part": (payload) => {
    const session = speechSessions.get(payload.token);
    if (!session) throw new Error("Recording session expired.");
    if (session.failed) return false;
    const bytes = audioBytes(payload.audio);
    if (bytes.length < 45) return true;
    const mime = payload.mime || "audio/wav";
    const filename = payload.filename || (String(mime).includes("wav") ? "recording.wav" : "recording.webm");
    const sttEngine = store.getSettings().sttEngine === "openai" ? "openai" : "parakeet";
    session.pending = session.pending.then(async () => {
      if (session.failed) return;
      try {
        if (sttEngine === "parakeet") {
          const result = await parakeet.transcribeWav(bytes, app.getPath("userData"));
          if (result.text) session.texts.push(result.text);
          if (result.language) session.language = result.language;
        } else {
          const body = await providers.postTranscription(fetch, () => providers.transcriptionRequest({
            provider: "openai",
            apiKey: readKey(),
            audio: bytes,
            mime,
            filename,
          }));
          const text = providers.parseTranscription(body);
          const language = providers.detectedLanguage(body);
          if (text) session.texts.push(text);
          if (language) session.language = language;
        }
      } catch (error) {
        session.failed = error instanceof Error ? error : new Error(String(error));
      }
    });
    return true;
  },
  "speech.finish": (payload) => enqueueSpeech(async () => {
    const session = speechSessions.get(payload.token);
    if (!session) throw new Error("Recording session expired.");
    speechSessions.delete(payload.token);
    await session.pending;
    if (session.failed) throw session.failed;
    const raw = audio.joinTranscripts(session.texts);
    if (!raw) return { empty: true, text: "" };
    const prepared = flow.prepareTranscript(raw, library());
    return commitTranscript(raw, prepared, {
      appName: payload.appName,
      url: payload.url,
      durationMs: payload.durationMs || 0,
      language: session.language,
      paste: true,
      overlay: false,
    });
  }),
  "speech.speak": async (payload) => {
    const settings = store.getSettings();
    const request = providers.speechRequest({
      provider: settings.provider,
      apiKey: readKey(),
      text: payload.text,
      voice: settings.ttsVoice || undefined,
      model: settings.ttsModel || undefined,
    });
    const audio = await providers.postAudio(fetch, request);
    return { base64: audio.bytes.toString("base64"), type: audio.type };
  },
  "speech.translate": async (payload) => {
    const text = await translateText(payload.text, payload.targetLanguage);
    return { text };
  },
  "speech.rewrite": async (payload) => {
    const settings = store.getSettings();
    const local = flow.polishLocal(payload.text);
    if (!payload.useApi) return { text: local, local: true };
    const output = await completeChat((base) => providers.rewriteRequest({
      ...base,
      text: payload.text,
      style: payload.style || settings.tone,
    }));
    store.addPolish({ input_text: payload.text, output_text: output, style: payload.style || settings.tone });
    return { text: output, local: false };
  },
  "speech.instruct": async (payload) => {
    const output = await completeChat((base) => providers.instructRequest({
      ...base,
      prompt: payload.prompt,
      context: payload.context || "",
    }));
    const row = store.addInstruct({ prompt: payload.prompt, response: output });
    return row;
  },
  "speech.summarize": async (payload) => {
    const output = await completeChat((base) => providers.summaryRequest({
      ...base,
      transcript: payload.transcript,
    }));
    return store.saveMeeting({ ...payload.meeting, summary: output, status: "summarized" });
  },
  "file.export": async () => {
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: "Export OpenFlow",
      defaultPath: "openflow-export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    fs.writeFileSync(choice.filePath, JSON.stringify(store.snapshot(), null, 2));
    return { canceled: false, filePath: choice.filePath };
  },
  "file.import": async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: "Import local data",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
    const parsed = JSON.parse(fs.readFileSync(choice.filePaths[0], "utf8"));
    if (parsed && parsed.settings) delete parsed.settings.apiKey;
    if (parsed) delete parsed.apiKey;
    store.replaceAll(parsed);
    return { canceled: false };
  },
};

function ipcFloat32(samples) {
  if (samples instanceof Float32Array) return samples;
  if (ArrayBuffer.isView(samples)) return Float32Array.from(samples);
  if (Array.isArray(samples)) return Float32Array.from(samples);
  if (samples && Array.isArray(samples.data)) return Float32Array.from(samples.data);
  return new Float32Array(0);
}

ipcMain.handle("audio-codec", (_event, payload) => {
  const body = payload || {};
  if (body.op === "flush") return audio.flushSampleCount(body.sampleRate);
  const samples = ipcFloat32(body.samples);
  if (body.op === "audible") return audio.audible(samples, body.sampleRate);
  if (body.op === "slices" || body.op === "pack") {
    const loud = audio.audible(samples, body.sampleRate);
    if (body.op === "pack" && !loud && !body.force) return { audible: false, slices: [] };
    const slices = audio.wavSlices(samples, body.sampleRate).map((part) => Uint8Array.from(part));
    if (body.op === "pack") return { audible: loud, slices };
    return slices;
  }
  throw new Error("Unknown action.");
});

ipcMain.handle("dispatch", async (_event, action, payload) => {
  const handler = actions[action];
  if (!handler) throw new Error("Unknown action.");
  try {
    return await handler(payload || {});
  } catch (error) {
    store.addNotification({ title: "Error", body: error.message || "Unknown error" });
    if (!String(action).startsWith("speech.")) sendOverlay({ mode: "hidden" });
    throw error;
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
  app.whenReady().then(async () => {
    const allowMedia = (_contents, permission) => permission === "media" || permission === "microphone" || permission === "audioCapture";
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowMedia(null, permission));
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(allowMedia(null, permission));
    });
    if (typeof session.defaultSession.setDevicePermissionHandler === "function") {
      session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === "microphone" || details.deviceType === "audio");
    }
    store = createStore(path.join(app.getPath("userData"), "openflow.json"));
    await runModelInstallerIfNeeded();
    syncSttEngine();
    createWindows();
    createTray();
    await ensureMicrophone();
    startChord();
    watchPointer();
  });
}

app.on("before-quit", () => {
  quitting = true;
  if (pointerTimer) clearInterval(pointerTimer);
  stopChord();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {});
