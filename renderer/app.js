"use strict";

const views = [
  ["dictate", "Dictation", '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="1.5" width="4" height="7.5" rx="2"></rect><path d="M4 8a4 4 0 0 0 8 0M8 12v2"></path></svg>'],
  ["notes", "Notes", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.5L12 5v8.5H4z"></path><path d="M9.2 2.6V5.2H12"></path></svg>'],
  ["usage", "Usage", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5V9M6.5 12.5V6.5M10 12.5V4M13.5 12.5V8"></path></svg>'],
  ["settings", "Settings", '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.1"></circle><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1"></path></svg>'],
];

const state = { desk: null, view: "dictate", editor: null, askKey: false };
let loadGeneration = 0;

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
  if (!editor || editor.dataset.id !== state.editor.id) return;
  const title = editor.querySelector("#editor-title");
  const body = editor.querySelector("#editor-body");
  if (!title || !body) return;
  state.editor = { ...state.editor, title: title.value, content: body.value };
}

async function load(pending) {
  const generation = loadGeneration + 1;
  loadGeneration = generation;
  captureEditor();
  if (pending && pending.openPadId && state.editor && state.editor.id !== pending.openPadId) {
    await window.openflow.dispatch("pads.save", {
      id: state.editor.id,
      title: state.editor.title,
      content: state.editor.content,
    });
  }
  const desk = await window.openflow.dispatch("desk.snapshot");
  if (generation !== loadGeneration) return;
  state.desk = desk;
  if (pending && pending.openPadId) {
    const pad = (desk.pads || []).find((row) => row.id === pending.openPadId);
    if (pad) {
      state.view = "notes";
      state.askKey = false;
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
    }
  } else if ((pending && pending.askKey) || !desk.settings.hasKey) {
    if (!desk.settings.hasKey) {
      state.view = "settings";
      state.askKey = true;
      state.editor = null;
    }
  }
  render();
  if (state.askKey && state.view === "settings") {
    const key = document.querySelector("#api-key");
    if (key) key.focus();
  }
}

async function saveApiKey() {
  const key = document.querySelector("#api-key");
  if (!key) return;
  const value = key.value.trim();
  if (!value) return;
  await window.openflow.dispatch("settings.save", { apiKey: value });
  key.value = "";
  state.askKey = false;
  state.view = "dictate";
  await load();
}

function render() {
  const nav = document.querySelector("#nav");
  nav.innerHTML = views.map(([id, label, icon]) => {
    const current = id === state.view ? ' aria-current="page"' : "";
    return `<button type="button" data-nav="${id}"${current}>${icon}${label}</button>`;
  }).join("");
  document.querySelector("#title").textContent = views.find(([id]) => id === state.view)[1];
  const view = document.querySelector("#view");
  if (state.view === "notes") view.innerHTML = notesHtml();
  else if (state.view === "usage") view.innerHTML = usageHtml();
  else if (state.view === "settings") view.innerHTML = settingsHtml();
  else view.innerHTML = dictateHtml();
  paintEditor();
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

function dictateHtml() {
  const history = state.desk.history || [];
  const last = history[0];
  const text = last ? (last.edited_text || last.formatted_text || last.asr_text) : "";
  const hero = `<div class="hero-card"><div class="hero-copy"><strong>Hold shortcut to dictate anywhere</strong><p>Speak naturally and release to paste into the focused field, or open a new note tab automatically.</p></div><p class="shortcut"><kbd>Ctrl</kbd> + <kbd>Win</kbd></p></div>`;
  const latest = text
    ? `<div class="section-label">Latest Dictation</div><div class="transcript-card"><div class="transcript-head"><span>${esc(when(last.created_at))}</span><button type="button" class="btn-secondary" data-copy-text="${esc(text)}">Copy</button></div><p class="lead">${esc(text)}</p></div>`
    : `<p class="empty">No dictations yet. Hold <kbd>Ctrl</kbd> + <kbd>Win</kbd> or click the microphone in the bottom bar to start.</p>`;
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
  const toolbar = `<div class="notes-toolbar"><button type="button" class="text-button" data-new-pad>+ New Note</button></div>`;
  if (!pads.length) return `${toolbar}<p class="empty">No notes yet. Click "+ New Note" or dictate without a focused text field.</p>`;
  const tabs = `<div class="note-tabs" role="tablist">${pads.map((pad) => {
    const on = state.editor && state.editor.id === pad.id;
    const title = pad.title || "Note";
    return `<div class="note-tab-wrap" aria-selected="${on ? "true" : "false"}"><button type="button" class="note-tab" role="tab" data-pad-open="${esc(pad.id)}" aria-selected="${on ? "true" : "false"}">${esc(title)}</button><button type="button" data-pad-delete="${esc(pad.id)}" aria-label="Delete">×</button></div>`;
  }).join("")}</div>`;
  return `${toolbar}${tabs}`;
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
  return `<div class="stats"><article class="stat"><b>${minutes(report.durationMs)} min</b><span>Audio, ${report.dictations || 0} dictations</span></article><article class="stat"><b>${money(report.costUsd)}</b><span>Estimated API cost</span></article><article class="stat"><b>${new Intl.NumberFormat("en-US").format(report.words || 0)}</b><span>Spoken words</span></article></div><div class="chart-card"><div class="chart" role="img" aria-label="Usage over the last 30 days">${bars}</div><div class="axis"><span>${esc(dayLabel(report.from))}</span><span>${esc(dayLabel(report.to))}</span></div></div><p class="note">Estimated at list price: ${price} USD per minute (gpt-transcribe). Not an invoice.</p>`;
}

function settingsHtml() {
  const hint = state.desk.settings.hasKey ? "Saved locally (enter a new key to replace)" : "sk-...";
  const ask = (state.askKey || !state.desk.settings.hasKey)
    ? `<div class="prompt-banner">Please enter your OpenAI API key to enable speech recognition.</div>`
    : "";
  return `<div class="settings-card">${ask}<label class="key">OpenAI API Key<div class="key-row"><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(hint)}"><button type="button" id="save-key" class="btn-primary">Save Key</button></div></label><p class="note">Your API key is encrypted locally on this PC via Windows safeStorage and is used exclusively for requests to api.openai.com.</p></div>`;
}

function paintEditor() {
  const editor = document.querySelector("#editor");
  if (!state.editor || state.view !== "notes") {
    editor.hidden = true;
    editor.dataset.id = "";
    return;
  }
  if (editor.dataset.id === state.editor.id && editor.querySelector("#editor-title")) {
    editor.hidden = false;
    return;
  }
  editor.dataset.id = state.editor.id;
  editor.hidden = false;
  editor.innerHTML = `<div class="editor-bar"><button type="button" id="editor-back">Close</button><div class="editor-actions"><span id="editor-feedback" class="save-badge" aria-live="polite">Saved ✓</span><button type="button" id="editor-save">Save</button></div></div><input id="editor-title" value="${esc(state.editor.title || "")}" placeholder="Note title" aria-label="Title"><textarea id="editor-body" placeholder="Write or paste your note..." aria-label="Note">${esc(state.editor.content || "")}</textarea>`;
  const body = editor.querySelector("#editor-body");
  if (body) body.focus();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-nav]");
    if (!button) return;
    state.view = button.dataset.nav;
    if (state.view !== "notes") state.editor = null;
    if (state.view === "notes" || state.view === "usage") load().catch(() => {});
    else render();
  });
  document.querySelector("#view").addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-copy-text]");
    if (copyBtn && window.openflow) {
      await window.openflow.dispatch("clipboard.copy", { text: copyBtn.dataset.copyText });
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1000);
      return;
    }
    const created = event.target.closest("[data-new-pad]");
    const remove = event.target.closest("[data-pad-delete]");
    const open = event.target.closest("[data-pad-open]");
    if (created) {
      const pad = await window.openflow.dispatch("pads.save", { title: "Note", content: "" });
      state.view = "notes";
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      await load();
      return;
    }
    if (remove) {
      const deletingId = remove.dataset.padDelete;
      if (state.editor && state.editor.id === deletingId) state.editor = null;
      await window.openflow.dispatch("pads.delete", { id: deletingId });
      await load();
      return;
    }
    if (open) {
      const pad = (state.desk.pads || []).find((item) => item.id === open.dataset.padOpen);
      if (!pad) return;
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      render();
    }
  });
  document.querySelector("#editor").addEventListener("click", async (event) => {
    if (event.target.closest("#editor-back")) {
      state.editor = null;
      render();
      return;
    }
    const button = event.target.closest("#editor-save");
    if (!button || !state.editor) return;
    const title = document.querySelector("#editor-title");
    const body = document.querySelector("#editor-body");
    const feedback = document.querySelector("#editor-feedback");
    const nextTitle = (title && title.value.trim()) ? title.value.trim() : "Note";
    const nextContent = body ? body.value : state.editor.content;
    state.editor = { ...state.editor, title: nextTitle, content: nextContent };
    button.disabled = true;
    button.textContent = "Saved ✓";
    button.classList.add("saved");
    if (feedback) feedback.classList.add("visible");
    await window.openflow.dispatch("pads.save", {
      id: state.editor.id,
      title: nextTitle,
      content: nextContent,
    });
    const desk = await window.openflow.dispatch("desk.snapshot");
    state.desk = desk;
    const view = document.querySelector("#view");
    if (state.view === "notes" && view) view.innerHTML = notesHtml();
    await new Promise((resolve) => setTimeout(resolve, 900));
    button.disabled = false;
    button.textContent = "Save";
    button.classList.remove("saved");
    if (feedback) feedback.classList.remove("visible");
  });
  if (!window.openflow) return;
  window.openflow.on("desk-refresh", (payload) => {
    load(payload).catch(() => {});
  });
  window.openflow.dispatch("desk.pending").then((pending) => load(pending)).catch(() => {});
});
