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
  renamingId: null,
  askKey: false,
  onboardingStep: null,
};
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
  const settings = desk.settings || {};
  if ((pending && pending.onboarding) || !settings.onboardingDone) {
    if (!state.onboardingStep) state.onboardingStep = "choose";
  } else {
    state.onboardingStep = null;
  }
  if (pending && pending.openPadId) {
    const pad = (desk.pads || []).find((row) => row.id === pending.openPadId);
    if (pad) {
      state.view = "notes";
      state.askKey = false;
      state.renamingId = null;
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
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
  await window.openflow.dispatch("settings.save", { apiKey: value, onboardingDone: true });
  key.value = "";
  state.askKey = false;
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
  const showingEditor = state.view === "notes" && Boolean(state.editor);
  view.hidden = showingEditor;
  if (!showingEditor) {
    if (state.view === "notes") view.innerHTML = notesHtml();
    else if (state.view === "usage") view.innerHTML = usageHtml();
    else if (state.view === "settings") view.innerHTML = settingsHtml();
    else view.innerHTML = dictateHtml();
  }
  paintEditor();
  paintOnboarding();

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
  if (state.renamingId && state.view === "notes" && !showingEditor) {
    const renameInput = view.querySelector(".note-rename-input");
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
    }
  }
}

function dictateHtml() {
  const history = state.desk.history || [];
  const last = history[0];
  const text = last ? (last.edited_text || last.formatted_text || last.asr_text) : "";
  const engine = (state.desk.settings && state.desk.settings.sttEngine === "openai") ? "OpenAI API (gpt-transcribe)" : "Parakeet v3 (Local)";
  const hero = `<div class="hero-card"><div class="hero-copy"><strong>Hold shortcut to dictate anywhere</strong><p>Active engine: ${esc(engine)}. Speak naturally and release to paste or save as a note.</p></div><p class="shortcut"><kbd>Ctrl</kbd> + <kbd>Win</kbd></p></div>`;
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
  const pencilSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.5 13.5 4.8 6 12.3H3.7V10z"></path></svg>';
  const list = `<div class="notes-list" role="list">${pads.map((pad) => {
    const title = pad.title || "Note";
    const preview = String(pad.content || "").trim().replace(/\s+/g, " ") || "Empty note — click to edit";
    if (state.renamingId === pad.id) {
      return `<div class="note-box" role="listitem"><button type="button" class="note-rename-btn" data-pad-rename-save="${esc(pad.id)}" title="Save title" aria-label="Save title">✓</button><div class="note-rename-form"><input class="note-rename-input" data-rename-input="${esc(pad.id)}" value="${esc(title)}" aria-label="Note title"><button type="button" class="btn-secondary" data-pad-rename-save="${esc(pad.id)}">Save</button></div><button type="button" class="note-delete-btn" data-pad-delete="${esc(pad.id)}" aria-label="Delete">×</button></div>`;
    }
    return `<div class="note-box" role="listitem"><button type="button" class="note-rename-btn" data-pad-rename="${esc(pad.id)}" title="Rename note" aria-label="Rename">${pencilSvg}</button><button type="button" class="note-open-btn" data-pad-open="${esc(pad.id)}"><strong>${esc(title)}</strong><span>${esc(preview)}</span></button><button type="button" class="note-delete-btn" data-pad-delete="${esc(pad.id)}" aria-label="Delete">×</button></div>`;
  }).join("")}</div>`;
  return `${toolbar}${list}`;
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
  return `<div class="stats"><article class="stat"><b>${minutes(report.durationMs)} min</b><span>Audio, ${report.dictations || 0} dictations</span></article><article class="stat"><b>${money(report.costUsd)}</b><span>Estimated API cost</span></article><article class="stat"><b>${new Intl.NumberFormat("en-US").format(report.words || 0)}</b><span>Spoken words</span></article></div><div class="chart-card"><div class="chart" role="img" aria-label="Usage over the last 30 days">${bars}</div><div class="axis"><span>${esc(dayLabel(report.from))}</span><span>${esc(dayLabel(report.to))}</span></div></div><p class="note">Estimated at list price: ${price} USD per minute (gpt-transcribe). Local Parakeet v3 dictations are free ($0.00).</p>`;
}

function settingsHtml() {
  const settings = state.desk.settings || {};
  const sttEngine = settings.sttEngine === "openai" ? "openai" : "parakeet";
  const pk = settings.parakeet || { installed: false, state: "stopped" };
  let pkBadge = "Local Model";
  let pkReady = false;
  if (sttEngine === "parakeet") {
    if (pk.state === "ready" || pk.installed) {
      pkBadge = "Active in Background";
      pkReady = true;
    } else if (pk.state === "installing") {
      pkBadge = "Installing Model...";
    } else if (pk.state === "loading") {
      pkBadge = "Loading Model...";
    } else {
      pkBadge = "Ready";
      pkReady = true;
    }
  } else if (pk.installed) {
    pkBadge = "Installed";
  }
  const hint = settings.hasKey ? "Saved locally (enter a new key to replace)" : "sk-... (optional with Parakeet v3)";
  const ask = (sttEngine === "openai" && (state.askKey || !settings.hasKey))
    ? `<div class="prompt-banner">Please enter your OpenAI API key to use cloud speech recognition, or switch to Parakeet v3 (Local).</div>`
    : "";
  return `<div class="settings-card">${ask}<div class="section-label">Speech-to-Text Engine</div><div class="engine-grid" role="radiogroup" aria-label="Speech-to-Text Engine"><button type="button" class="engine-option" role="radio" data-stt-select="parakeet" aria-checked="${sttEngine === "parakeet" ? "true" : "false"}"><div class="engine-head"><strong>Parakeet v3 (Open-Source)</strong><span class="engine-badge${pkReady ? " ready" : ""}">${esc(pkBadge)}</span></div><p>Runs locally on your PC in the background. Free and requires no API key.</p></button><button type="button" class="engine-option" role="radio" data-stt-select="openai" aria-checked="${sttEngine === "openai" ? "true" : "false"}"><div class="engine-head"><strong>OpenAI API</strong><span class="engine-badge${sttEngine === "openai" && settings.hasKey ? " ready" : ""}">${settings.hasKey ? "Key Saved" : "Cloud"}</span></div><p>Uses OpenAI gpt-transcribe with your personal API key.</p></button></div><label class="key">OpenAI API Key ${sttEngine === "parakeet" ? "(Optional)" : ""}<div class="key-row"><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(hint)}"><button type="button" id="save-key" class="btn-primary">Save Key</button></div></label></div>`;
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
  editor.innerHTML = `<div class="editor-bar"><button type="button" id="editor-back">← Back</button><div class="editor-actions"><span id="editor-feedback" class="save-badge" aria-live="polite">Saved ✓</span><button type="button" id="editor-save">Save</button></div></div><input id="editor-title" value="${esc(state.editor.title || "")}" placeholder="Note title" aria-label="Title"><textarea id="editor-body" placeholder="Write or paste your note..." aria-label="Note">${esc(state.editor.content || "")}</textarea>`;
  const body = editor.querySelector("#editor-body");
  if (body) body.focus();
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
    host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Enter OpenAI API Key</h2><p class="sub">Enter your OpenAI API key to start dictating with gpt-transcribe.</p></div><div class="key-row"><input id="onboard-api-key" class="onboard-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..."></div><div class="onboarding-actions"><button type="button" class="btn-secondary" data-onboard-back>← Back</button><button type="button" class="btn-primary" data-onboard-save-key>Save & Start</button></div></div>`;
    const input = host.querySelector("#onboard-api-key");
    if (input) input.focus();
    return;
  }
  host.innerHTML = `<div class="onboarding-card" role="dialog" aria-modal="true"><div><h2>Welcome to OpenFlow</h2><p class="sub">Choose how you want to transcribe your voice. You can change this anytime in Settings.</p></div><div class="onboarding-choices"><button type="button" class="onboarding-choice" data-onboard-choose="parakeet"><strong><span>Parakeet v3 (Local Open-Source)</span><span class="engine-badge ready">Recommended · Free</span></strong><span>Installed with OpenFlow. Runs locally on your PC in the background — start immediately without an API key.</span></button><button type="button" class="onboarding-choice" data-onboard-choose="openai"><strong><span>OpenAI API (gpt-transcribe)</span><span class="engine-badge">Cloud API</span></strong><span>Transcribe in the cloud using your own OpenAI API key.</span></button></div></div>`;
}

async function commitInlineRename(padId) {
  const input = document.querySelector(`[data-rename-input="${padId}"]`);
  const pad = (state.desk && state.desk.pads || []).find((row) => row.id === padId);
  state.renamingId = null;
  if (!pad) {
    render();
    return;
  }
  const nextTitle = input && input.value.trim() ? input.value.trim() : (pad.title || "Note");
  await window.openflow.dispatch("pads.save", {
    id: pad.id,
    title: nextTitle,
    content: pad.content || "",
  });
  await load();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-nav]");
    if (!button) return;
    state.view = button.dataset.nav;
    state.editor = null;
    state.renamingId = null;
    if (state.view === "notes" || state.view === "usage" || state.view === "settings") load().catch(() => {});
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

    const sttSelect = event.target.closest("[data-stt-select]");
    if (sttSelect && window.openflow) {
      const nextEngine = sttSelect.dataset.sttSelect === "openai" ? "openai" : "parakeet";
      await window.openflow.dispatch("settings.save", { sttEngine: nextEngine, onboardingDone: true });
      if (nextEngine === "parakeet") state.askKey = false;
      await load();
      return;
    }

    const created = event.target.closest("[data-new-pad]");
    if (created) {
      const pad = await window.openflow.dispatch("pads.save", { title: "Note", content: "" });
      state.view = "notes";
      state.renamingId = null;
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      await load();
      return;
    }

    const renameBtn = event.target.closest("[data-pad-rename]");
    if (renameBtn) {
      state.renamingId = renameBtn.dataset.padRename;
      render();
      return;
    }

    const renameSaveBtn = event.target.closest("[data-pad-rename-save]");
    if (renameSaveBtn) {
      await commitInlineRename(renameSaveBtn.dataset.padRenameSave);
      return;
    }

    const remove = event.target.closest("[data-pad-delete]");
    if (remove) {
      const deletingId = remove.dataset.padDelete;
      if (state.editor && state.editor.id === deletingId) state.editor = null;
      if (state.renamingId === deletingId) state.renamingId = null;
      await window.openflow.dispatch("pads.delete", { id: deletingId });
      await load();
      return;
    }

    const open = event.target.closest("[data-pad-open]");
    if (open) {
      const pad = (state.desk.pads || []).find((item) => item.id === open.dataset.padOpen);
      if (!pad) return;
      state.renamingId = null;
      state.editor = { id: pad.id, title: pad.title || "Note", content: pad.content || "" };
      const editor = document.querySelector("#editor");
      if (editor) editor.dataset.id = "";
      render();
    }
  });

  document.querySelector("#view").addEventListener("keydown", async (event) => {
    const renameInput = event.target.closest("[data-rename-input]");
    if (!renameInput) return;
    if (event.key === "Enter") {
      event.preventDefault();
      await commitInlineRename(renameInput.dataset.renameInput);
    } else if (event.key === "Escape") {
      event.preventDefault();
      state.renamingId = null;
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
    await new Promise((resolve) => setTimeout(resolve, 260));
    state.editor = null;
    await load();
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
  window.openflow.on("desk-refresh", (payload) => {
    load(payload).catch(() => {});
  });
  window.openflow.dispatch("desk.pending").then((pending) => load(pending)).catch(() => {});
});
