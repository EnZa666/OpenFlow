"use strict";

const views = [
  ["dictate", "Dictation", '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="1.5" width="4" height="7.5" rx="2"></rect><path d="M4 8a4 4 0 0 0 8 0M8 12v2"></path></svg>'],
  ["notes", "Notes", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.5L12 5v8.5H4z"></path><path d="M9.2 2.6V5.2H12"></path></svg>'],
  ["usage", "Usage", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5V9M6.5 12.5V6.5M10 12.5V4M13.5 12.5V8"></path></svg>'],
  ["settings", "Settings", '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.1"></circle><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1"></path></svg>'],
];

const state = {
  desk: null,
  view: "dictate",
  editor: null,
  confirmDeleteId: null,
  confirmSttEngine: null,
  askKey: false,
  onboardingStep: null,
  draftBubbleElements: null,
  draftFloatingBubble: null,
  draftVoiceNote: null,
  sttInfoParakeet: false,
  sttInfoOpenai: false,
};
let loadGeneration = 0;
let draggedElemId = null;
let draggedShelfId = null;

const EDITOR_PLACEHOLDER = "Write or dictate a note...";
// Live voice dictation into the note editor (streamed from the main process as "note-voice").
const editorVoice = { state: "idle", waiters: [], base: "", transcript: "", key: "" };

// "Take voice note" is not a standalone element: it always sits attached to the left of the mic.
const VOICE_NOTE_DEF = {
  id: "vnote",
  name: "Take Voice Note",
  miniIcon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.1" stroke="currentColor" stroke-width="1.7"></circle><circle cx="8" cy="8" r="2.7" fill="currentColor"></circle></svg>`,
};

function voiceComboHtml(withVoiceNote, removable) {
  if (!withVoiceNote) {
    return `<div class="elem-voice-combo no-vnote" aria-hidden="true"><div class="elem-mic"><svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75"></rect><path d="M3.75 8.25a5.25 5.25 0 0 0 10.5 0M9 13.5V16"></path></svg></div></div>`;
  }
  const minus = removable
    ? `<button type="button" class="elem-minus-btn elem-minus-vnote" data-vnote-remove title="Remove ${VOICE_NOTE_DEF.name}" aria-label="Remove ${VOICE_NOTE_DEF.name}">−</button>`
    : "";
  return `<div class="elem-voice-combo"><div class="elem-vtrack" aria-hidden="true"></div><div class="elem-vnote" title="${VOICE_NOTE_DEF.name}"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.1" stroke="currentColor" stroke-width="1.7"></circle><circle cx="8" cy="8" r="2.7" fill="currentColor"></circle></svg>${minus}</div><div class="elem-mic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75"></rect><path d="M3.75 8.25a5.25 5.25 0 0 0 10.5 0M9 13.5V16"></path></svg></div></div>`;
}

const BUBBLE_ELEMENT_DEFS = {
  voice: {
    id: "voice",
    name: "Voice & Note",
    html: `<div class="elem-voice-combo" aria-hidden="true"><div class="elem-vtrack"></div><div class="elem-vnote"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.1" stroke="currentColor" stroke-width="1.7"></circle><circle cx="8" cy="8" r="2.7" fill="currentColor"></circle></svg></div><div class="elem-mic"><svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75"></rect><path d="M3.75 8.25a5.25 5.25 0 0 0 10.5 0M9 13.5V16"></path></svg></div></div>`,
    miniIcon: `<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75"></rect><path d="M3.75 8.25a5.25 5.25 0 0 0 10.5 0M9 13.5V16"></path></svg>`,
  },
  note: {
    id: "note",
    name: "Notes",
    html: `<div class="elem-single" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.75" y="2.25" width="10.5" height="13.5" rx="1.6"></rect><path d="M6.25 6.75h5.5M6.25 10h5.5"></path></svg></div>`,
    miniIcon: `<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.75" y="2.25" width="10.5" height="13.5" rx="1.6"></rect><path d="M6.25 6.75h5.5M6.25 10h5.5"></path></svg>`,
  },
  tune: {
    id: "tune",
    name: "Hub",
    html: `<div class="elem-single" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 7.75 9 2.5l6.25 5.25"></path><path d="M4.25 6.75v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-7.5"></path><path d="M7.25 15.25v-4.25h3.5v4.25"></path></svg></div>`,
    miniIcon: `<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 7.75 9 2.5l6.25 5.25"></path><path d="M4.25 6.75v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-7.5"></path><path d="M7.25 15.25v-4.25h3.5v4.25"></path></svg>`,
  },
  shot: {
    id: "shot",
    name: "Screenshot",
    html: `<div class="elem-single" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.4V3.2H6.4M11.6 3.2h3.2v3.2M14.8 11.6v3.2h-3.2M6.4 14.8H3.2v-3.2"></path><circle cx="9" cy="9" r="1.7"></circle></svg></div>`,
    miniIcon: `<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.4V3.2H6.4M11.6 3.2h3.2v3.2M14.8 11.6v3.2h-3.2M6.4 14.8H3.2v-3.2"></path><circle cx="9" cy="9" r="1.7"></circle></svg>`,
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return "";
  return `${parts[1]}/${parts[2]}`;
}

function money(value) {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value) || 0)} USD`;
}

function minutes(durationMs) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((Number(durationMs) || 0) / 60000);
}

function captureEditor() {
  if (!state.editor) return;
  const editor = document.querySelector("#editor");
  const expectedKey = state.editor.id || "__draft__";
  if (!editor || editor.dataset.id !== expectedKey) return;
  const title = editor.querySelector("#editor-title");
  const body = editor.querySelector("#editor-body");
  if (!title || !body) return;
  state.editor = { ...state.editor, title: title.value, content: body.value };
}

async function load(pending) {
  const generation = loadGeneration + 1;
  loadGeneration = generation;
  captureEditor();
  const desk = await window.openflow.dispatch("desk.snapshot");
  if (generation !== loadGeneration) return;
  state.desk = desk;
  const settings = desk.settings || {};
  if (!state.draftBubbleElements) {
    state.draftBubbleElements = Array.isArray(settings.bubbleElements) ? [...settings.bubbleElements] : ["voice", "note", "tune", "shot"];
  }
  if (!state.draftFloatingBubble) {
    state.draftFloatingBubble = settings.floatingBubble || "active";
  }
  if (state.draftVoiceNote === null) {
    state.draftVoiceNote = settings.voiceNoteButton !== false;
  }
  if ((pending && pending.onboarding) || !settings.onboardingDone) {
    if (!state.onboardingStep) state.onboardingStep = "choose";
  } else {
    state.onboardingStep = null;
  }
  if (pending && pending.newDraftPad) {
    state.view = "notes";
    state.askKey = false;
    state.confirmDeleteId = null;
    state.editor = { id: "", isDraft: true, title: "Note", content: "" };
    const editor = document.querySelector("#editor");
    if (editor) editor.dataset.id = "";
  } else if (pending && pending.openPadId) {
    const pad = (desk.pads || []).find((row) => row.id === pending.openPadId);
    if (pad) {
      state.view = "notes";
      state.askKey = false;
      state.confirmDeleteId = null;
      state.editor = { id: pad.id, isDraft: false, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
    }
  } else if (settings.onboardingDone && ((pending && pending.askKey) || (settings.sttEngine === "openai" && !settings.hasKey))) {
    if (!settings.hasKey) {
      state.view = "settings";
      state.askKey = true;
      state.editor = null;
    }
  }
  render();
  if (state.askKey && state.view === "settings" && !state.onboardingStep) {
    const key = document.querySelector("#api-key");
    if (key) key.focus();
  }
}

async function saveApiKey() {
  const key = document.querySelector("#api-key");
  if (!key) return;
  const value = key.value.trim();
  if (!value) return;
  const saveKeyBtn = document.querySelector("#save-key");
  if (saveKeyBtn) {
    saveKeyBtn.disabled = true;
    saveKeyBtn.textContent = "Saved";
    saveKeyBtn.classList.add("saved");
  }
  await window.openflow.dispatch("settings.save", { apiKey: value, onboardingDone: true });
  key.value = "";
  state.askKey = false;
  await new Promise((r) => setTimeout(r, 600));
  await load();
}

function render() {
  const nav = document.querySelector("#nav");
  nav.innerHTML = views.map(([id, label, icon]) => {
    const current = id === state.view ? ' aria-current="page"' : "";
    return `<button type="button" data-nav="${id}"${current}>${icon}${label}</button>`;
  }).join("");
  document.querySelector("#title").textContent = views.find(([id]) => id === state.view)[1];
  const viewHead = document.querySelector(".view-head");
  const view = document.querySelector("#view");
  const showingEditor = state.view === "notes" && Boolean(state.editor);
  if (viewHead) viewHead.hidden = showingEditor;
  view.hidden = showingEditor;
  if (!showingEditor) {
    if (state.view === "notes") view.innerHTML = notesHtml();
    else if (state.view === "usage") view.innerHTML = usageHtml();
    else if (state.view === "settings") view.innerHTML = settingsHtml();
    else view.innerHTML = dictateHtml();
  }
  paintEditor();
  paintOnboarding();
  paintConfirmModal();

  const key = view.querySelector("#api-key");
  if (key) {
    key.addEventListener("change", saveApiKey);
    key.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveApiKey();
      }
    });
  }
  const saveKeyBtn = view.querySelector("#save-key");
  if (saveKeyBtn) {
    saveKeyBtn.addEventListener("click", saveApiKey);
  }
}

function shortcutKeysHtml(shortcut) {
  if (shortcut === "ctrl+space") return "<kbd>Ctrl</kbd> + <kbd>Space</kbd>";
  if (shortcut === "ctrl+alt") return "<kbd>Ctrl</kbd> + <kbd>Alt</kbd>";
  if (shortcut === "ctrl+shift") return "<kbd>Ctrl</kbd> + <kbd>Shift</kbd>";
  return "<kbd>Ctrl</kbd> + <kbd>Win</kbd>";
}

function dictateHtml() {
  const history = state.desk.history || [];
  const last = history[0];
  const text = last ? (last.edited_text || last.formatted_text || last.asr_text) : "";
  const settings = state.desk.settings || {};
  const engine = settings.sttEngine === "openai" ? "gpt-transcribe" : "Parakeet v3 (Local)";
  const shortcut = settings.dictationShortcut || "ctrl+win";
  const isToggle = settings.dictationMode === "toggle";
  const headline = isToggle ? "Press shortcut to start and stop dictation" : "Hold shortcut to dictate anywhere";
  const subline = isToggle
    ? `Active engine: ${esc(engine)}. Press once to start speaking and press a second time to finish.`
    : `Active engine: ${esc(engine)}. Speak naturally while holding and release to paste or save as a note.`;
  const hero = `<div class="hero-card"><div class="hero-copy"><strong>${headline}</strong><p>${subline}</p></div><p class="shortcut">${shortcutKeysHtml(shortcut)}</p></div>`;
  const latest = text
    ? `<div class="section-label">Latest Dictation</div><div class="transcript-card"><div class="transcript-head"><span>${esc(when(last.created_at))}</span><button type="button" class="btn-secondary" data-copy-text="${esc(text)}">Copy</button></div><p class="lead">${esc(text)}</p></div>`
    : `<p class="empty">No dictations yet. Use ${shortcutKeysHtml(shortcut)} or click the microphone in the bottom bar to start.</p>`;
  const recent = history.slice(1, 5);
  const recentHtml = recent.length
    ? `<div class="section-label">Recent History</div><div class="history-list">${recent.map((row) => {
      const body = row.edited_text || row.formatted_text || row.asr_text || "";
      return `<div class="history-row"><p>${esc(body)}</p><time>${esc(when(row.created_at))}</time></div>`;
    }).join("")}</div>`
    : "";
  return `${hero}${latest}${recentHtml}`;
}

function notesHtml() {
  const pads = [...(state.desk.pads || [])].reverse();
  const penPaperSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
  const fab = `<button type="button" class="notes-fab" data-new-pad aria-label="New Note" title="New Note">${penPaperSvg}</button>`;
  if (!pads.length) return `<p class="empty">No notes yet. Tap the button in the bottom right or dictate without a focused text field.</p>${fab}`;
  const trashSvg = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 5h11M7 5V3.6c0-.6.5-1.1 1.1-1.1h1.8c.6 0 1.1.5 1.1 1.1V5M5.2 5l.6 9.4c.05.9.8 1.6 1.7 1.6h3c.9 0 1.65-.7 1.7-1.6L12.8 5M7.6 8.2v4.5M10.4 8.2v4.5"></path></svg>';
  const list = `<div class="notes-list" role="list">${pads.map((pad) => {
    const title = pad.title || "Note";
    const preview = String(pad.content || "").trim().replace(/\s+/g, " ") || "Empty note — click to edit";
    return `<div class="note-box" role="listitem"><button type="button" class="note-open-btn" data-pad-open="${esc(pad.id)}"><strong>${esc(title)}</strong><span>${esc(preview)}</span></button><button type="button" class="note-delete-btn" data-pad-delete="${esc(pad.id)}" title="Delete note" aria-label="Delete note">${trashSvg}</button></div>`;
  }).join("")}</div>`;
  return `${list}${fab}`;
}

function usageHtml() {
  const report = state.desk.usage || { days: [], words: 0, durationMs: 0, costUsd: 0, pricePerMinute: 0.0045, from: "", to: "", dictations: 0 };
  const basis = report.days.some((day) => day.durationMs > 0) ? "durationMs" : "words";
  const peak = report.days.reduce((max, day) => Math.max(max, Number(day[basis]) || 0), 0);
  const bars = report.days.map((day) => {
    const height = peak ? Math.max(4, Math.round(((Number(day[basis]) || 0) / peak) * 100)) : 4;
    const label = `${day.date}: ${day.words} words, ${day.dictations} dictations`;
    return `<i style="height:${height}%" title="${esc(label)}"></i>`;
  }).join("");
  const price = new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(report.pricePerMinute || 0.0045);
  return `<div class="stats"><article class="stat"><b>${minutes(report.durationMs)} min</b><span>Audio, ${report.dictations || 0} dictations</span></article><article class="stat"><b>${money(report.costUsd)}</b><span>Estimated API cost</span></article><article class="stat"><b>${new Intl.NumberFormat("en-US").format(report.words || 0)}</b><span>Spoken words</span></article></div><div class="chart-card"><div class="chart" role="img" aria-label="Usage over the last 30 days">${bars}</div><div class="axis"><span>${esc(dayLabel(report.from))}</span><span>${esc(dayLabel(report.to))}</span></div></div><p class="note">Only dictations made with OpenAI (gpt-transcribe) are counted here (${price} USD per minute).</p>`;
}

function settingsHtml() {
  const settings = state.desk.settings || {};
  const sttEngine = settings.sttEngine === "openai" ? "openai" : "parakeet";
  const shortcut = settings.dictationShortcut || "ctrl+win";
  const isToggle = settings.dictationMode === "toggle";
  const shortcuts = [
    { id: "ctrl+win", keys: "<kbd>Ctrl</kbd> + <kbd>Win</kbd>" },
    { id: "ctrl+space", keys: "<kbd>Ctrl</kbd> + <kbd>Space</kbd>" },
    { id: "ctrl+alt", keys: "<kbd>Ctrl</kbd> + <kbd>Alt</kbd>" },
    { id: "ctrl+shift", keys: "<kbd>Ctrl</kbd> + <kbd>Shift</kbd>" },
  ];
  const shortcutHtml = shortcuts.map((item) => {
    const checked = shortcut === item.id ? "true" : "false";
    return `<button type="button" class="shortcut-option" role="radio" data-shortcut-select="${item.id}" aria-checked="${checked}"><span class="shortcut-keys">${item.keys}</span></button>`;
  }).join("");
  const modeTitle = isToggle ? "Press Once to Start / Second Time to Stop" : "Hold Shortcut to Dictate";
  const modeDesc = isToggle
    ? "Press the shortcut once to start recording, and press it a second time to finish."
    : "Keep the shortcut held down while speaking and release to finish dictation.";
  const dictationCard = `<div class="settings-card"><div class="section-label">Dictation</div><div class="shortcut-grid" role="radiogroup" aria-label="Dictation Shortcut">${shortcutHtml}</div><div class="mode-toggle-card"><div class="mode-toggle-copy"><strong>${modeTitle}</strong><span>${modeDesc}</span></div><div class="mode-slider-wrap"><span class="mode-slider-label${!isToggle ? " active" : ""}">Hold</span><button type="button" class="switch-btn" role="switch" data-dictation-mode-toggle aria-checked="${isToggle ? "true" : "false"}" aria-label="Toggle between Hold to Dictate and Press to Start/Stop"><span class="switch-thumb"></span></button><span class="mode-slider-label${isToggle ? " active" : ""}">Start / Stop</span></div></div></div>`;
  const hint = settings.hasKey ? "Saved locally (enter a new key to replace)" : "sk-... (optional with Parakeet v3)";
  const ask = (sttEngine === "openai" && (state.askKey || !settings.hasKey))
    ? `<div class="prompt-banner">Please enter your OpenAI API key to use cloud speech recognition, or switch to Parakeet v3 (Local).</div>`
    : "";
function sttInfoIcon(active) {
  if (active) {
    return `<svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="3" x2="13" y2="13"></line><line x1="13" y1="3" x2="3" y2="13"></line></svg>`;
  }
  return `<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3.5" r="1.5"/><rect x="6.5" y="7" width="3" height="6" rx="1"/></svg>`;
}

function parakeetCardHtml(sttEngine) {
  const isChecked = sttEngine === "parakeet";
  const isInfo = Boolean(state.sttInfoParakeet);
  if (isInfo) {
    return `<div role="radio" tabindex="0" class="engine-option" data-stt-select="parakeet" aria-checked="${isChecked ? "true" : "false"}"><div class="engine-info-head"><div class="engine-info-meta"><strong class="engine-info-title">Parakeet v3</strong><span class="engine-info-tagline">Deployed on your CPU &mdash; 0.6B model</span></div><button type="button" class="engine-info-btn active" data-stt-info="parakeet" title="Close details" aria-label="Close details">${sttInfoIcon(true)}</button></div><div class="engine-metrics"><div class="engine-metric-row"><div class="engine-metric-labels"><span>Accuracy</span><strong>94%</strong></div><div class="engine-bar-track"><div class="engine-bar-fill" style="width: 94%;"></div></div></div><div class="engine-metric-row"><div class="engine-metric-labels"><span>Speed (CPU)</span><strong>22×</strong></div><div class="engine-bar-track"><div class="engine-bar-fill" style="width: 60%;"></div></div></div></div></div>`;
  }
  return `<div role="radio" tabindex="0" class="engine-option" data-stt-select="parakeet" aria-checked="${isChecked ? "true" : "false"}"><div class="engine-head"><strong>Parakeet v3 (Open-Source)</strong><button type="button" class="engine-info-btn" data-stt-info="parakeet" title="Model details" aria-label="Model details">${sttInfoIcon(false)}</button></div><p>Runs locally on your PC in the background. Free and requires no API key.</p></div>`;
}

function openaiCardHtml(sttEngine) {
  const isChecked = sttEngine === "openai";
  const isInfo = Boolean(state.sttInfoOpenai);
  if (isInfo) {
    return `<div role="radio" tabindex="0" class="engine-option" data-stt-select="openai" aria-checked="${isChecked ? "true" : "false"}"><div class="engine-info-head"><div class="engine-info-meta"><strong class="engine-info-title">gpt-transcribe</strong><span class="engine-info-tagline">Automatic AI error correction</span></div><button type="button" class="engine-info-btn active" data-stt-info="openai" title="Close details" aria-label="Close details">${sttInfoIcon(true)}</button></div><div class="engine-metrics"><div class="engine-metric-row"><div class="engine-metric-labels"><span>Accuracy</span><strong>93%</strong></div><div class="engine-bar-track"><div class="engine-bar-fill" style="width: 93%;"></div></div></div><div class="engine-metric-row"><div class="engine-metric-labels"><span>Speed (API)</span><strong>34×</strong></div><div class="engine-bar-track"><div class="engine-bar-fill" style="width: 80%;"></div></div></div></div></div>`;
  }
  return `<div role="radio" tabindex="0" class="engine-option" data-stt-select="openai" aria-checked="${isChecked ? "true" : "false"}"><div class="engine-head"><strong>gpt-transcribe</strong><button type="button" class="engine-info-btn" data-stt-info="openai" title="Model details" aria-label="Model details">${sttInfoIcon(false)}</button></div><p>Uses OpenAI gpt-transcribe with your personal API key.</p></div>`;
}

  const sttCard = `<div class="settings-card">${ask}<div class="section-label">Speech-to-Text Engine</div><div class="engine-grid" role="radiogroup" aria-label="Speech-to-Text Engine">${parakeetCardHtml(sttEngine)}${openaiCardHtml(sttEngine)}</div><label class="key">OpenAI API Key ${sttEngine === "parakeet" ? "(Optional)" : ""}<div class="key-row"><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(hint)}"><button type="button" id="save-key" class="btn-primary">Save Key</button></div></label></div>`;

  // Floating Bubble Appearance
  const bubbleStyle = state.draftFloatingBubble || settings.floatingBubble || "active";
  const bubbleOptions = [
    { id: "active", title: "Active", desc: "Default visible bubble on your desktop" },
    { id: "dimmed", title: "Grayed Out", desc: "Dimmed bubble, highlights on hover" },
    { id: "hidden", title: "Hidden", desc: "No bubble; use keyboard shortcut only" },
  ];
  const bubbleOptionsHtml = bubbleOptions.map((opt) => {
    const checked = bubbleStyle === opt.id ? "true" : "false";
    return `<button type="button" class="bubble-style-option" role="radio" data-bubble-select="${opt.id}" aria-checked="${checked}"><strong class="bubble-opt-title">${esc(opt.title)}</strong><span class="bubble-opt-desc">${esc(opt.desc)}</span></button>`;
  }).join("");
  const bubbleCard = `<div class="settings-card"><div class="section-label">Floating Bubble Appearance</div><div class="bubble-style-grid" role="radiogroup" aria-label="Floating Bubble Appearance">${bubbleOptionsHtml}</div></div>`;

  // Manage Elements Preview and Customization
  const currentElems = state.draftBubbleElements || ["voice", "note", "tune", "shot"];
  const allKeys = ["voice", "note", "tune", "shot"];
  const removedKeys = allKeys.filter((k) => !currentElems.includes(k));

  const voiceNoteOn = state.draftVoiceNote !== false;
  const previewItemsHtml = currentElems.map((key) => {
    const def = BUBBLE_ELEMENT_DEFS[key];
    if (!def) return "";
    const canRemove = currentElems.length > 1;
    const minusBtn = canRemove
      ? `<button type="button" class="elem-minus-btn" data-elem-remove="${key}" title="Remove ${def.name}" aria-label="Remove ${def.name}">−</button>`
      : "";
    const html = key === "voice" ? voiceComboHtml(voiceNoteOn, true) : def.html;
    return `<div class="bubble-preview-item" draggable="true" data-elem-id="${key}" title="${def.name} (drag to reorder)">${minusBtn}${html}</div>`;
  }).join("");

  const shelfItems = removedKeys.map((k) => {
    const def = BUBBLE_ELEMENT_DEFS[k];
    return `<button type="button" class="removed-elem-btn" draggable="true" data-shelf-elem="${k}" data-elem-add="${k}" title="Add back ${def.name} (click or drag onto the bubble)">${def.miniIcon}<span>${def.name}</span><span class="elem-plus-badge">+</span></button>`;
  });
  if (!voiceNoteOn && currentElems.includes("voice")) {
    shelfItems.push(`<button type="button" class="removed-elem-btn" draggable="true" data-shelf-elem="vnote" data-vnote-add title="Add back ${VOICE_NOTE_DEF.name} (click or drop anywhere on the bubble — it snaps back to the mic)">${VOICE_NOTE_DEF.miniIcon}<span>${VOICE_NOTE_DEF.name}</span><span class="elem-plus-badge">+</span></button>`);
  }
  const removedShelfHtml = shelfItems.length > 0
    ? `<div class="removed-elements-shelf"><div class="shelf-head"><span class="shelf-label">Removed Elements</span></div><div class="removed-elements-list">${shelfItems.join("")}</div></div>`
    : "";

  const manageCard = `<div class="settings-card manage-elements-card"><div class="section-label">Manage Elements</div><div class="bubble-preview-wrap"><div class="bubble-preview-pill" id="bubble-preview-pill">${previewItemsHtml}</div></div>${removedShelfHtml}<div class="bubble-manage-actions"><button type="button" class="btn-secondary" id="bubble-reset">Reset to Default</button><button type="button" class="btn-primary" id="bubble-save">Save Changes</button></div></div>`;

  return `${sttCard}${dictationCard}${bubbleCard}${manageCard}`;
}

function paintEditor() {
  const editor = document.querySelector("#editor");
  if (!state.editor || state.view !== "notes") {
    editor.hidden = true;
    editor.dataset.id = "";
    return;
  }
  const editorKey = state.editor.id || "__draft__";
  if (editor.dataset.id === editorKey && editor.querySelector("#editor-title")) {
    editor.hidden = false;
    return;
  }
  editor.dataset.id = editorKey;
  editor.hidden = false;
  const titleVal = state.editor.title || "Note";
  const titleCh = Math.max(5, Math.min(32, titleVal.length + 1));
  editor.innerHTML = `<header class="note-bubble-head"><input id="editor-title" value="${esc(titleVal)}" placeholder="Note title" aria-label="Title" style="width: ${titleCh}ch;"><button type="button" id="editor-back">Back</button></header><textarea id="editor-body" placeholder="Write or dictate a note..." aria-label="Note">${esc(state.editor.content || "")}</textarea><footer class="note-bubble-foot"><button type="button" id="editor-voice" class="note-voice-btn idle" title="Click to dictate" aria-label="Dictate into note" aria-pressed="false"><svg class="icon-active" width="22" height="22" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.1" stroke="#000000" stroke-width="1.8"></circle><circle cx="8" cy="8" r="2.7" fill="#000000"></circle></svg><svg class="icon-idle" width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="#000000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75"></rect><path d="M3.75 8.25a5.25 5.25 0 0 0 10.5 0M9 13.5V16"></path></svg><span class="icon-busy note-spin"></span></button><button type="button" id="editor-copy">Copy</button><button type="button" id="editor-save">Save</button></footer>`;
  paintEditorVoice();
  const body = editor.querySelector("#editor-body");
  if (body) body.focus();
}

function currentEditorKey() {
  return state.editor ? (state.editor.id || "__draft__") : "";
}

function paintEditorVoice() {
  const next = editorVoice.state;
  const button = document.querySelector("#editor-voice");
  if (button) {
    button.className = `note-voice-btn ${next}`;
    button.disabled = next === "busy";
    button.title = next === "active" ? "Click to stop listening" : (next === "busy" ? "Transcribing..." : "Click to dictate");
    button.setAttribute("aria-pressed", next === "active" ? "true" : "false");
  }
  const body = document.querySelector("#editor-body");
  if (body) body.placeholder = next === "active" ? "Listening..." : EDITOR_PLACEHOLDER;
}

function setEditorVoiceState(next) {
  editorVoice.state = next;
  paintEditorVoice();
  if (next === "idle") {
    const waiters = editorVoice.waiters;
    editorVoice.waiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

function writeEditorVoiceText(text) {
  const body = document.querySelector("#editor-body");
  if (!body || editorVoice.key !== currentEditorKey()) return;
  const base = editorVoice.base;
  const prefix = base ? (/\s$/.test(base) ? base : `${base} `) : "";
  body.value = prefix + text;
  body.scrollTop = body.scrollHeight;
  if (document.activeElement === body) body.selectionStart = body.selectionEnd = body.value.length;
  if (state.editor) state.editor.content = body.value;
}

function onEditorVoice(message) {
  if (!message) return;
  if (message.type === "start") {
    const body = document.querySelector("#editor-body");
    editorVoice.key = currentEditorKey();
    editorVoice.base = body ? body.value : (state.editor ? state.editor.content || "" : "");
    editorVoice.transcript = "";
    setEditorVoiceState("active");
  }
  if (message.type === "text") {
    const clean = String(message.text || "").trim();
    if (clean) {
      editorVoice.transcript = (editorVoice.transcript ? `${editorVoice.transcript} ` : "") + clean;
      writeEditorVoiceText(editorVoice.transcript);
    }
  }
  if (message.type === "final") {
    const clean = String(message.text || "").trim();
    if (clean) {
      editorVoice.transcript = clean;
      writeEditorVoiceText(clean);
    }
  }
  if (message.type === "stopped" && editorVoice.state === "active") setEditorVoiceState("busy");
  if (message.type === "done") setEditorVoiceState("idle");
}

function stopEditorVoice() {
  if (editorVoice.state === "active" && window.openflow) window.openflow.dispatch("voicenote.stop").catch(() => {});
}

// Stop a running dictation and wait until its last words have landed in the editor.
function finishEditorVoice() {
  if (editorVoice.state === "idle" || !window.openflow) return Promise.resolve();
  const done = new Promise((resolve) => {
    editorVoice.waiters.push(resolve);
    setTimeout(resolve, 20000);
  });
  stopEditorVoice();
  return done;
}

function paintOnboarding() {
  const host = document.querySelector("#onboarding");
  if (!host) return;
  if (!state.onboardingStep) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  if (state.onboardingStep === "apikey") {
    host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Enter OpenAI API Key</h2><p class="sub">Enter your OpenAI API key to start dictating with gpt-transcribe.</p></div><div class="key-row"><input id="onboard-api-key" class="onboard-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..."></div><div class="onboarding-actions"><button type="button" class="btn-secondary" data-onboard-back>Back</button><button type="button" class="btn-primary" data-onboard-save-key>Save & Start</button></div></div>`;
    const input = host.querySelector("#onboard-api-key");
    if (input) input.focus();
    return;
  }
  host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Welcome to OpenFlow</h2><p class="sub">Choose how you want to transcribe your voice. You can change this anytime in Settings.</p></div><div class="onboarding-choices"><button type="button" class="onboarding-choice" data-onboard-choose="parakeet"><strong><span>Parakeet v3 (Local Open-Source)</span><span class="engine-badge ready">Recommended · Free</span></strong><span>Installed with OpenFlow. Runs locally on your PC in the background — start immediately without an API key.</span></button><button type="button" class="onboarding-choice" data-onboard-choose="openai"><strong><span>OpenAI API (gpt-transcribe)</span><span class="engine-badge">Cloud API</span></strong><span>Transcribe in the cloud using your own OpenAI API key.</span></button></div></div>`;
}

function paintConfirmModal() {
  const host = document.querySelector("#confirm-modal");
  if (!host) return;
  if (state.confirmSttEngine) {
    const label = state.confirmSttEngine === "openai"
      ? "gpt-transcribe"
      : "Parakeet v3 (Open-Source, Local)";
    host.hidden = false;
    host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Switch Speech-to-Text Model?</h2><p class="sub">Use <strong>${esc(label)}</strong> for all dictation sessions?</p></div><div class="onboarding-actions"><button type="button" class="btn-secondary" data-confirm-cancel>Cancel</button><button type="button" class="btn-primary" data-confirm-stt-ok>OK</button></div></div>`;
    return;
  }
  if (!state.confirmDeleteId) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const pad = (state.desk && state.desk.pads || []).find((row) => row.id === state.confirmDeleteId);
  const title = pad && pad.title ? pad.title : "this note";
  host.hidden = false;
  host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Delete Note?</h2><p class="sub">Are you sure you want to delete "${esc(title)}"? This action cannot be undone.</p></div><div class="onboarding-actions"><button type="button" class="btn-secondary" data-confirm-cancel>Cancel</button><button type="button" class="btn-danger" data-confirm-delete>Delete</button></div></div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const viewEl = document.querySelector("#view");
  if (viewEl) {
    viewEl.addEventListener("dragstart", (event) => {
      const shelfItem = event.target.closest("[data-shelf-elem]");
      if (shelfItem) {
        draggedShelfId = shelfItem.dataset.shelfElem;
        shelfItem.classList.add("dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("text/plain", draggedShelfId);
        }
        return;
      }
      const item = event.target.closest(".bubble-preview-item");
      if (!item) return;
      draggedElemId = item.dataset.elemId;
      item.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedElemId);
      }
    });

    viewEl.addEventListener("dragover", (event) => {
      if (draggedShelfId) {
        const pill = event.target.closest("#bubble-preview-pill");
        viewEl.querySelectorAll(".bubble-preview-pill.drop-active").forEach((el) => {
          if (el !== pill) el.classList.remove("drop-active");
        });
        if (pill) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          pill.classList.add("drop-active");
        }
        return;
      }
      const item = event.target.closest(".bubble-preview-item");
      if (item && draggedElemId) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (item.dataset.elemId !== draggedElemId) {
          viewEl.querySelectorAll(".bubble-preview-item.drop-target").forEach((el) => {
            if (el !== item) el.classList.remove("drop-target");
          });
          item.classList.add("drop-target");
        }
      }
    });

    viewEl.addEventListener("dragleave", (event) => {
      const item = event.target.closest(".bubble-preview-item");
      if (item) item.classList.remove("drop-target");
    });

    viewEl.addEventListener("dragend", () => {
      draggedElemId = null;
      draggedShelfId = null;
      viewEl.querySelectorAll(".bubble-preview-item, [data-shelf-elem]").forEach((el) => el.classList.remove("dragging", "drop-target"));
      viewEl.querySelectorAll(".bubble-preview-pill.drop-active").forEach((el) => el.classList.remove("drop-active"));
    });

    viewEl.addEventListener("drop", (event) => {
      if (draggedShelfId) {
        const shelfId = draggedShelfId;
        draggedShelfId = null;
        const pill = event.target.closest("#bubble-preview-pill");
        if (pill) {
          event.preventDefault();
          if (shelfId === "vnote") {
            // Wherever it lands on the bubble, the voice note button snaps back onto the mic.
            state.draftVoiceNote = true;
          } else {
            const list = [...(state.draftBubbleElements || ["voice", "note", "tune", "shot"])];
            if (!list.includes(shelfId)) {
              const target = event.target.closest(".bubble-preview-item");
              const toIdx = target ? list.indexOf(target.dataset.elemId) : -1;
              if (toIdx === -1) list.push(shelfId);
              else list.splice(toIdx, 0, shelfId);
              state.draftBubbleElements = list;
            }
          }
          render();
        }
        return;
      }
      const item = event.target.closest(".bubble-preview-item");
      if (item && draggedElemId && item.dataset.elemId !== draggedElemId) {
        event.preventDefault();
        const targetId = item.dataset.elemId;
        const list = [...(state.draftBubbleElements || ["voice", "note", "tune", "shot"])];
        const fromIdx = list.indexOf(draggedElemId);
        const toIdx = list.indexOf(targetId);
        if (fromIdx !== -1 && toIdx !== -1) {
          list.splice(fromIdx, 1);
          list.splice(toIdx, 0, draggedElemId);
          state.draftBubbleElements = list;
          render();
        }
      }
      draggedElemId = null;
      viewEl.querySelectorAll(".bubble-preview-item").forEach((el) => el.classList.remove("dragging", "drop-target"));
    });
  }

  document.querySelector("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-nav]");
    if (!button) return;
    stopEditorVoice();
    state.view = button.dataset.nav;
    state.editor = null;
    state.confirmDeleteId = null;
    if (state.view === "notes" || state.view === "usage" || state.view === "settings") load().catch(() => {});
    else render();
  });

  document.querySelector("#view").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      const option = event.target.closest(".engine-option");
      if (option && !event.target.closest(".engine-info-btn")) {
        event.preventDefault();
        option.click();
      }
    }
  });

  document.querySelector("#view").addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-copy-text]");
    if (copyBtn && window.openflow) {
      await window.openflow.dispatch("clipboard.copy", { text: copyBtn.dataset.copyText });
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1000);
      return;
    }

    const sttInfo = event.target.closest("[data-stt-info]");
    if (sttInfo) {
      event.stopPropagation();
      event.preventDefault();
      const engine = sttInfo.dataset.sttInfo;
      if (engine === "parakeet") {
        state.sttInfoParakeet = !state.sttInfoParakeet;
      } else if (engine === "openai") {
        state.sttInfoOpenai = !state.sttInfoOpenai;
      }
      render();
      return;
    }

    const sttSelect = event.target.closest("[data-stt-select]");
    if (sttSelect && window.openflow) {
      const nextEngine = sttSelect.dataset.sttSelect === "openai" ? "openai" : "parakeet";
      state.confirmDeleteId = null;
      state.confirmSttEngine = nextEngine;
      paintConfirmModal();
      return;
    }

    const shortcutSelect = event.target.closest("[data-shortcut-select]");
    if (shortcutSelect && window.openflow) {
      const nextShortcut = shortcutSelect.dataset.shortcutSelect;
      await window.openflow.dispatch("settings.save", { dictationShortcut: nextShortcut });
      await load();
      return;
    }

    const modeToggle = event.target.closest("[data-dictation-mode-toggle]");
    if (modeToggle && window.openflow) {
      const currentMode = (state.desk && state.desk.settings && state.desk.settings.dictationMode) || "hold";
      const nextMode = currentMode === "toggle" ? "hold" : "toggle";
      await window.openflow.dispatch("settings.save", { dictationMode: nextMode });
      await load();
      return;
    }

    const bubbleSelect = event.target.closest("[data-bubble-select]");
    if (bubbleSelect && window.openflow) {
      const nextStyle = bubbleSelect.dataset.bubbleSelect;
      state.draftFloatingBubble = nextStyle;
      await window.openflow.dispatch("settings.save", { floatingBubble: nextStyle });
      render();
      return;
    }

    if (event.target.closest("[data-vnote-remove]")) {
      state.draftVoiceNote = false;
      render();
      return;
    }

    if (event.target.closest("[data-vnote-add]")) {
      state.draftVoiceNote = true;
      render();
      return;
    }

    const elemRemove = event.target.closest("[data-elem-remove]");
    if (elemRemove) {
      const key = elemRemove.dataset.elemRemove;
      const list = state.draftBubbleElements || ["voice", "note", "tune", "shot"];
      if (list.length > 1) {
        state.draftBubbleElements = list.filter((k) => k !== key);
        render();
      }
      return;
    }

    const elemAdd = event.target.closest("[data-elem-add]");
    if (elemAdd) {
      const key = elemAdd.dataset.elemAdd;
      const list = state.draftBubbleElements || ["voice", "note", "tune", "shot"];
      if (!list.includes(key)) {
        state.draftBubbleElements = [...list, key];
        render();
      }
      return;
    }

    const bubbleReset = event.target.closest("#bubble-reset");
    if (bubbleReset) {
      state.draftBubbleElements = ["voice", "note", "tune", "shot"];
      state.draftFloatingBubble = "active";
      state.draftVoiceNote = true;
      render();
      return;
    }

    const bubbleSave = event.target.closest("#bubble-save");
    if (bubbleSave && window.openflow) {
      bubbleSave.disabled = true;
      bubbleSave.textContent = "Saving...";
      await window.openflow.dispatch("settings.save", {
        bubbleElements: state.draftBubbleElements || ["voice", "note", "tune", "shot"],
        floatingBubble: state.draftFloatingBubble || "active",
        voiceNoteButton: state.draftVoiceNote !== false,
      });
      bubbleSave.textContent = "Saved";
      bubbleSave.classList.add("saved");
      await new Promise((r) => setTimeout(r, 600));
      state.draftBubbleElements = null;
      state.draftFloatingBubble = null;
      state.draftVoiceNote = null;
      await load();
      return;
    }

    const created = event.target.closest("[data-new-pad]");
    if (created) {
      state.view = "notes";
      state.confirmDeleteId = null;
      state.editor = { id: "", isDraft: true, title: "Note", content: "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      render();
      return;
    }

    const remove = event.target.closest("[data-pad-delete]");
    if (remove) {
      state.confirmDeleteId = remove.dataset.padDelete;
      paintConfirmModal();
      return;
    }

    const open = event.target.closest("[data-pad-open]");
    if (open) {
      const pad = (state.desk.pads || []).find((item) => item.id === open.dataset.padOpen);
      if (!pad) return;
      state.confirmDeleteId = null;
      state.editor = { id: pad.id, isDraft: false, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      render();
    }
  });

  document.querySelector("#confirm-modal").addEventListener("click", async (event) => {
    if (event.target.closest("[data-confirm-cancel]") || event.target === document.querySelector("#confirm-modal")) {
      state.confirmDeleteId = null;
      state.confirmSttEngine = null;
      paintConfirmModal();
      return;
    }
    if (event.target.closest("[data-confirm-stt-ok]") && state.confirmSttEngine) {
      const nextEngine = state.confirmSttEngine;
      state.confirmSttEngine = null;
      await window.openflow.dispatch("settings.save", { sttEngine: nextEngine, onboardingDone: true });
      if (nextEngine === "parakeet") state.askKey = false;
      await load();
      return;
    }
    if (event.target.closest("[data-confirm-delete]") && state.confirmDeleteId) {
      const deletingId = state.confirmDeleteId;
      state.confirmDeleteId = null;
      if (state.editor && state.editor.id === deletingId) state.editor = null;
      await window.openflow.dispatch("pads.delete", { id: deletingId });
      await load();
    }
  });

  document.querySelector("#editor").addEventListener("click", async (event) => {
    if (event.target.closest("#editor-back")) {
      stopEditorVoice();
      state.editor = null;
      render();
      return;
    }
    if (event.target.closest("#editor-voice") && window.openflow) {
      if (editorVoice.state === "active") {
        stopEditorVoice();
      } else if (editorVoice.state === "idle") {
        window.openflow.dispatch("voicenote.start", { target: "desk" }).catch(() => {});
      }
      const body = document.querySelector("#editor-body");
      if (body) body.focus();
      return;
    }
    const copyBtn = event.target.closest("#editor-copy");
    if (copyBtn && window.openflow) {
      const body = document.querySelector("#editor-body");
      await window.openflow.dispatch("clipboard.copy", { text: body ? body.value : "" });
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("copied");
      }, 1000);
      return;
    }
    const button = event.target.closest("#editor-save");
    if (!button || !state.editor) return;
    button.disabled = true;
    await finishEditorVoice();
    if (!state.editor) return;
    const title = document.querySelector("#editor-title");
    const body = document.querySelector("#editor-body");
    const nextTitle = (title && title.value.trim()) ? title.value.trim() : "Note";
    const nextContent = body ? body.value : state.editor.content;
    button.textContent = "Saved";
    button.classList.add("saved");
    const saved = await window.openflow.dispatch("pads.save", {
      id: state.editor.id || undefined,
      title: nextTitle,
      content: nextContent,
    });
    state.editor = { id: saved.id, isDraft: false, title: nextTitle, content: nextContent };
    await new Promise((resolve) => setTimeout(resolve, 260));
    state.editor = null;
    await load();
  });

  document.querySelector("#editor").addEventListener("input", (event) => {
    if (event.target && event.target.id === "editor-title") {
      const len = event.target.value.length || 4;
      event.target.style.width = Math.max(5, Math.min(32, len + 1)) + "ch";
    }
  });

  document.querySelector("#editor").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      const saveBtn = document.querySelector("#editor-save");
      if (saveBtn && !saveBtn.disabled) saveBtn.click();
    }
  });

  document.querySelector("#onboarding").addEventListener("click", async (event) => {
    const choose = event.target.closest("[data-onboard-choose]");
    if (choose) {
      const choice = choose.dataset.onboardChoose;
      if (choice === "parakeet") {
        state.onboardingStep = null;
        state.askKey = false;
        state.view = "dictate";
        await window.openflow.dispatch("settings.save", { sttEngine: "parakeet", onboardingDone: true });
        await load();
      } else {
        state.onboardingStep = "apikey";
        paintOnboarding();
      }
      return;
    }
    if (event.target.closest("[data-onboard-back]")) {
      state.onboardingStep = "choose";
      paintOnboarding();
      return;
    }
    if (event.target.closest("[data-onboard-save-key]")) {
      const input = document.querySelector("#onboard-api-key");
      const val = input ? input.value.trim() : "";
      if (!val) {
        if (input) input.focus();
        return;
      }
      state.onboardingStep = null;
      state.askKey = false;
      state.view = "dictate";
      await window.openflow.dispatch("settings.save", { sttEngine: "openai", apiKey: val, onboardingDone: true });
      await load();
    }
  });

  document.querySelector("#onboarding").addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && event.target.closest("#onboard-api-key")) {
      event.preventDefault();
      const saveBtn = document.querySelector("[data-onboard-save-key]");
      if (saveBtn) saveBtn.click();
    }
  });

  if (!window.openflow) return;
  window.openflow.on("note-voice", onEditorVoice);
  window.openflow.on("desk-refresh", (payload) => {
    load(payload).catch(() => {});
  });
  window.openflow.dispatch("desk.pending").then((pending) => load(pending)).catch(() => {});
});
