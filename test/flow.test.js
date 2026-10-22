"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const flow = require("../src/flow");

const library = {
  corrections: [{ source_text: "flow", corrected_text: "OpenFlow" }],
  dictionary: [
    { phrase: "OpenFlow", replacement: "Open Flow", is_snippet: false },
    { phrase: "adresse", replacement: "Musterweg 1, 10115 Berlin", is_snippet: true },
  ],
  automations: [
    { name: "Signatur", enabled: true, trigger_phrase: "signatur", action: "prefix", action_value: "Viele Grüße." },
    { name: "Englisch", enabled: true, trigger_phrase: "übersetze", action: "translate", action_value: "Englisch" },
  ],
};

test("prepareTranscript applies corrections, dictionary, snippets, and automations", () => {
  const prepared = flow.prepareTranscript("bitte übersetze flow und setze die signatur", library);
  assert.match(prepared.text, /Open Flow/);
  assert.match(prepared.text, /Viele Grüße/);
  assert.deepEqual(prepared.followUps, [{ type: "translate", language: "Englisch" }]);
  assert.ok(prepared.wordCount > 0);
});

test("a snippet replaces the whole utterance", () => {
  const prepared = flow.prepareTranscript("adresse", library);
  assert.equal(prepared.text, "Musterweg 1, 10115 Berlin");
  assert.equal(prepared.snippet, "adresse");
});

test("stats count local history only", () => {
  const stats = flow.computeStats([
    { formatted_text: "eins zwei", word_count: 2, duration_ms: 1000, archived: false, app_name: "Editor", language: "de" },
    { formatted_text: "drei", word_count: 1, duration_ms: 500, archived: true, app_name: "Editor", language: "en" },
  ]);
  assert.equal(stats.dictations, 2);
  assert.equal(stats.archived, 1);
  assert.equal(stats.words, 3);
  assert.equal(stats.durationMs, 1500);
  assert.equal(stats.byApp.Editor, 2);
});

test("usageReport sums the last 30 local days from history", () => {
  const now = new Date(2026, 9, 22, 15, 0, 0);
  const report = flow.usageReport([
    { created_at: new Date(2026, 9, 22, 9, 0, 0).toISOString(), word_count: 10, duration_ms: 60000, formatted_text: "hallo welt", stt_engine: "openai" },
    { created_at: new Date(2026, 9, 22, 10, 0, 0).toISOString(), word_count: 50, duration_ms: 120000, formatted_text: "lokal", stt_engine: "parakeet" },
    { created_at: new Date(2026, 8, 23, 12, 0, 0).toISOString(), word_count: 2, duration_ms: 30000 },
    { created_at: new Date(2026, 8, 22, 12, 0, 0).toISOString(), word_count: 99, duration_ms: 999999 },
    { created_at: "kein-datum", word_count: 5, duration_ms: 1000 },
  ], now);
  assert.equal(report.days.length, 30);
  assert.equal(report.from, "2026-09-23");
  assert.equal(report.to, "2026-10-22");
  assert.equal(report.words, 12);
  assert.equal(report.durationMs, 90000);
  assert.equal(report.dictations, 2);
  assert.equal(report.costUsd, 0.00675);
  assert.equal(report.model, "gpt-transcribe");
  assert.equal(report.pricePerMinute, flow.TRANSCRIBE_USD_PER_MINUTE);
  assert.equal(report.days[0].words, 2);
  assert.equal(report.days[29].words, 10);
  assert.equal(report.days[29].costUsd, 0.0045);
});

test("tour lists every desk section", () => {
  const ids = flow.tourSteps().map((step) => step.id);
  for (const id of ["dictate", "history", "dictionary", "snippets", "notes", "meetings", "calendar", "todos", "folders", "polish", "translate", "instruct", "scratchpad", "corrections", "links", "automations", "stats", "style", "notifications", "settings"]) {
    assert.ok(ids.includes(id), id);
  }
});
