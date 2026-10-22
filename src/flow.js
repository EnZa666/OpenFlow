"use strict";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordCount(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  return parts.length;
}

function polishLocal(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

function applyCorrections(text, corrections) {
  let output = String(text || "");
  const applied = [];
  const sorted = [...(corrections || [])].sort((a, b) => b.source_text.length - a.source_text.length);
  for (const row of sorted) {
    if (!row.source_text) continue;
    const pattern = new RegExp(escapeRegExp(row.source_text), "gi");
    if (!pattern.test(output)) continue;
    pattern.lastIndex = 0;
    output = output.replace(pattern, row.corrected_text);
    applied.push(row.source_text);
  }
  return { text: output, applied };
}

function applyDictionary(text, entries) {
  let output = String(text || "");
  const used = [];
  const rows = [...(entries || [])]
    .filter((row) => row.replacement && !row.is_snippet)
    .sort((a, b) => b.phrase.length - a.phrase.length);
  for (const row of rows) {
    const pattern = new RegExp(`\\b${escapeRegExp(row.phrase)}\\b`, "gi");
    if (!pattern.test(output)) continue;
    pattern.lastIndex = 0;
    output = output.replace(pattern, row.replacement);
    used.push(row.phrase);
  }
  return { text: output, used };
}

function expandSnippet(text, entries) {
  const trimmed = String(text || "").trim();
  const match = (entries || []).find((row) => row.is_snippet && row.phrase && row.phrase.toLowerCase() === trimmed.toLowerCase());
  if (!match || !match.replacement) return { text: trimmed, snippet: null };
  return { text: match.replacement, snippet: match.phrase };
}

function runAutomations(text, automations, entries) {
  let output = String(text || "");
  const fired = [];
  const followUps = [];
  for (const rule of automations || []) {
    if (!rule.enabled || !rule.trigger_phrase) continue;
    const pattern = new RegExp(escapeRegExp(rule.trigger_phrase), "i");
    if (!pattern.test(output)) continue;
    if (rule.action === "replace") {
      output = output.replace(new RegExp(escapeRegExp(rule.trigger_phrase), "gi"), rule.action_value || "");
    } else if (rule.action === "prefix") {
      output = `${rule.action_value || ""} ${output}`.trim();
    } else if (rule.action === "snippet") {
      const snippet = (entries || []).find((row) => row.is_snippet && row.phrase === rule.action_value);
      if (snippet && snippet.replacement) output = snippet.replacement;
    } else if (rule.action === "translate") {
      followUps.push({ type: "translate", language: rule.action_value || "English" });
    }
    fired.push(rule.name || rule.trigger_phrase);
  }
  return { text: output, fired, followUps };
}

function prepareTranscript(raw, library) {
  const corrected = applyCorrections(raw, library.corrections);
  const dictated = applyDictionary(corrected.text, library.dictionary);
  const snippet = expandSnippet(dictated.text, library.dictionary);
  const automated = runAutomations(snippet.text, library.automations, library.dictionary);
  const text = polishLocal(automated.text);
  return {
    text,
    usedPhrases: dictated.used,
    snippet: snippet.snippet,
    fired: automated.fired,
    followUps: automated.followUps,
    wordCount: wordCount(text),
  };
}

// OpenAI list price for gpt-transcribe, USD per minute of audio. An estimate, not an invoice.
const TRANSCRIBE_USD_PER_MINUTE = 0.0045;

function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function roundMoney(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function usageReport(history, now = new Date(), pricePerMinute = TRANSCRIBE_USD_PER_MINUTE) {
  const today = startOfLocalDay(now);
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const days = [];
  const index = new Map();
  for (let offset = 0; offset < 30; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const date = localDateKey(day);
    index.set(date, offset);
    days.push({ date, words: 0, durationMs: 0, dictations: 0, costUsd: 0 });
  }
  for (const row of history || []) {
    if (row && row.stt_engine === "parakeet") continue;
    const created = new Date(row && row.created_at);
    if (Number.isNaN(created.getTime())) continue;
    const slot = index.get(localDateKey(created));
    if (slot == null) continue;
    const words = Number(row.word_count) || wordCount(row.edited_text || row.formatted_text || row.asr_text);
    const durationMs = Math.max(0, Number(row.duration_ms) || 0);
    days[slot].words += words;
    days[slot].durationMs += durationMs;
    days[slot].dictations += 1;
    days[slot].costUsd = roundMoney(days[slot].costUsd + (durationMs / 60000) * pricePerMinute);
  }
  const totals = days.reduce((sum, day) => ({
    words: sum.words + day.words,
    durationMs: sum.durationMs + day.durationMs,
    dictations: sum.dictations + day.dictations,
    costUsd: sum.costUsd + day.costUsd,
  }), { words: 0, durationMs: 0, dictations: 0, costUsd: 0 });
  return {
    days,
    words: totals.words,
    durationMs: totals.durationMs,
    dictations: totals.dictations,
    costUsd: roundMoney(totals.costUsd),
    pricePerMinute,
    model: "gpt-transcribe",
    from: days[0].date,
    to: days[days.length - 1].date,
  };
}

function computeStats(history) {
  const rows = history || [];
  const words = rows.reduce((sum, row) => sum + (Number(row.word_count) || wordCount(row.formatted_text || row.asr_text)), 0);
  const duration = rows.reduce((sum, row) => sum + (Number(row.duration_ms) || 0), 0);
  const byApp = {};
  const byLanguage = {};
  for (const row of rows) {
    const app = row.app_name || "Unknown";
    byApp[app] = (byApp[app] || 0) + 1;
    const language = row.language || "unknown";
    byLanguage[language] = (byLanguage[language] || 0) + 1;
  }
  return {
    dictations: rows.length,
    archived: rows.filter((row) => row.archived).length,
    words,
    durationMs: duration,
    byApp,
    byLanguage,
  };
}

function tourSteps() {
  return [
    { id: "dictate", title: "Dictation", body: "Record your voice. Audio is transcribed with your API key and formatted locally." },
    { id: "history", title: "History", body: "Every dictation stays on this PC. You can edit, archive, read aloud, or translate it." },
    { id: "dictionary", title: "Dictionary", body: "Custom spellings and replacements apply locally before text is inserted." },
    { id: "snippets", title: "Snippets", body: "A spoken keyword can expand into saved text." },
    { id: "notes", title: "Notes", body: "Notes, versions, and pinned items stay local on your machine." },
    { id: "meetings", title: "Meetings", body: "Transcripts are stored locally. Summaries are sent to your API only on request." },
    { id: "calendar", title: "Calendar", body: "Events are local entries and can be linked to a meeting." },
    { id: "todos", title: "Tasks", body: "Tasks stay on this device, including completion state." },
    { id: "folders", title: "Folders", body: "Folders group meetings locally." },
    { id: "polish", title: "Polish", body: "Local polish cleans up spacing. Rewriting uses your API key." },
    { id: "translate", title: "Translation", body: "Translation, speech-to-text, and text-to-speech run via Groq or OpenAI." },
    { id: "instruct", title: "Instructions", body: "Writing prompts use the same key and store prompt and response locally." },
    { id: "scratchpad", title: "Scratchpad", body: "A single block for temporary text, stored locally." },
    { id: "corrections", title: "Corrections", body: "Fixed replacements are applied to new transcripts." },
    { id: "links", title: "Links", body: "Saved URLs open in your browser. There is no cloud account sync." },
    { id: "automations", title: "Automations", body: "Local rules can replace text, prepend prefixes, or trigger a translation." },
    { id: "stats", title: "Statistics", body: "Numbers are computed purely from local history." },
    { id: "style", title: "Style", body: "Tone and language settings apply to local formatting and API requests." },
    { id: "notifications", title: "Notifications", body: "Notices about saved dictations and errors stay local." },
    { id: "settings", title: "Settings", body: "Choose Groq or OpenAI and store your key only on this device. OpenFlow stays in the system tray while the shortcut starts listening." },
  ];
}

module.exports = {
  wordCount,
  polishLocal,
  applyCorrections,
  applyDictionary,
  expandSnippet,
  runAutomations,
  prepareTranscript,
  computeStats,
  usageReport,
  TRANSCRIBE_USD_PER_MINUTE,
  tourSteps,
};
