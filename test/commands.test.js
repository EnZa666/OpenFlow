"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const commands = require("../src/commands");
const { createStore } = require("../src/store");

test("command validation rejects empty, invalid characters, traversal, and reserved names", () => {
  assert.match(commands.validateName("", []), /enter a name/i);
  assert.match(commands.validateName("   ", []), /enter a name/i);
  assert.match(commands.validateName(" leading", []), /space/i);
  assert.match(commands.validateName("trailing ", []), /space/i);
  assert.match(commands.validateName("a".repeat(commands.MAX_NAME + 1), []), /characters/i);

  // Invalid characters / traversal
  assert.match(commands.validateName("foo/bar", []), /only letters/i);
  assert.match(commands.validateName("foo\\bar", []), /only letters/i);
  assert.match(commands.validateName("..", []), /only letters/i);
  assert.match(commands.validateName("foo*bar", []), /only letters/i);
  assert.match(commands.validateName("foo|bar", []), /only letters/i);
  assert.match(commands.validateName("foo;bar", []), /only letters/i);
  assert.match(commands.validateName("foo&bar", []), /only letters/i);
  assert.match(commands.validateName("foo.bar", []), /only letters/i);

  // Reserved Windows device names
  assert.match(commands.validateName("con", []), /reserved/i);
  assert.match(commands.validateName("PRN", []), /reserved/i);
  assert.match(commands.validateName("aux", []), /reserved/i);
  assert.match(commands.validateName("nul", []), /reserved/i);
  assert.match(commands.validateName("COM1", []), /reserved/i);

  // Duplicate name check
  const existing = [{ name: "Backup Data" }];
  assert.match(commands.validateName("backup data", existing), /already exists/i);
  assert.match(commands.validateName("BACKUP DATA", existing), /already exists/i);

  // Valid names
  assert.equal(commands.validateName("Backup-Data_01", existing), "");
  assert.equal(commands.validateName("Clean Temp", existing), "");
  assert.equal(commands.validateName("Restart Service", existing), "");
});

test("scriptPath prevents directory traversal and checks extension", () => {
  const dir = path.join(os.tmpdir(), "openflow-test-commands");
  const validCmd = { name: "test_run", type: "powershell", extension: ".ps1" };
  const p = commands.scriptPath(dir, validCmd);
  assert.equal(p, path.join(path.resolve(dir), "test_run.ps1"));

  // Extension mismatch
  assert.throws(() => commands.scriptPath(dir, { name: "test", type: "powershell", extension: ".bat" }), /type/i);
  // Unknown type
  assert.throws(() => commands.scriptPath(dir, { name: "test", type: "sh", extension: ".sh" }), /type/i);
});

test("writeScript and removeScript persist script content with proper encoding and CRLF", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-cmd-"));
  try {
    const psCmd = { name: "HealthCheck", type: "powershell", extension: ".ps1", content: "Write-Host 'OK'\nGet-Date" };
    const psFile = commands.writeScript(dir, psCmd);
    assert.ok(fs.existsSync(psFile));
    const raw = fs.readFileSync(psFile);
    // PowerShell script should start with UTF-8 BOM
    assert.equal(raw[0], 0xef);
    assert.equal(raw[1], 0xbb);
    assert.equal(raw[2], 0xbf);
    const text = fs.readFileSync(psFile, "utf8");
    assert.ok(text.includes("\r\n"));

    const batCmd = { name: "EchoTest", type: "bat", extension: ".bat", content: "@echo off\necho 123" };
    const batFile = commands.writeScript(dir, batCmd);
    assert.ok(fs.existsSync(batFile));
    assert.equal(fs.readFileSync(batFile, "utf8"), "@echo off\r\necho 123");

    commands.removeScript(dir, psCmd);
    assert.ok(!fs.existsSync(psFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launchSpec returns correct executable and visible console arguments", () => {
  const psSpec = commands.launchSpec({ type: "powershell" }, "C:\\scripts\\test.ps1");
  assert.equal(psSpec.exe, "powershell.exe");
  assert.ok(psSpec.args.includes("-NoExit"));
  assert.ok(psSpec.args.includes("-File"));
  assert.ok(psSpec.args.includes("C:\\scripts\\test.ps1"));

  const batSpec = commands.launchSpec({ type: "bat" }, "C:\\scripts\\test.bat");
  assert.equal(batSpec.exe, "cmd.exe");
  assert.ok(batSpec.args.includes("/k"));

  const cmdSpec = commands.launchSpec({ type: "cmd" }, "C:\\scripts\\test.cmd");
  assert.equal(cmdSpec.exe, "cmd.exe");
  assert.ok(cmdSpec.args.includes("/k"));
});

test("store manages commands and synchronizes bubbleElements on delete", () => {
  const store = createStore(":memory:");
  store.updateSettings({ bubbleElements: ["voice", "note"] });

  const c1 = store.createCommand({ name: "Restart Network", type: "powershell", content: "Restart-NetAdapter *" });
  assert.ok(c1.id);
  assert.equal(c1.name, "Restart Network");
  assert.equal(c1.type, "powershell");
  assert.equal(c1.extension, ".ps1");
  assert.equal(c1.content, "Restart-NetAdapter *");
  assert.ok(c1.created_at);
  assert.ok(c1.modified_at);

  // Duplicate name rejected
  assert.throws(() => store.createCommand({ name: "restart network", type: "bat", content: "" }));

  // Add command to bubble elements
  store.updateSettings({ bubbleElements: ["voice", `cmd:${c1.id}`, "note"] });
  assert.deepEqual(store.getSettings().bubbleElements, ["voice", `cmd:${c1.id}`, "note"]);

  // Save command updates only content and modified_at
  const updated = store.saveCommand({ id: c1.id, content: "Restart-NetAdapter -Name 'Wi-Fi'" });
  assert.equal(updated.content, "Restart-NetAdapter -Name 'Wi-Fi'");
  assert.equal(updated.name, "Restart Network");
  assert.equal(updated.type, "powershell");

  // Deleting command removes it from store AND strips cmd:<id> from bubbleElements
  const removed = store.deleteCommand(c1.id);
  assert.equal(removed.id, c1.id);
  assert.equal(store.listCommands().length, 0);
  assert.deepEqual(store.getSettings().bubbleElements, ["voice", "note"]);
});

test("run execution handles success, missing script, and user cancellation (UAC 1223)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-cmd-run-"));
  try {
    const cmd = { name: "PingTest", type: "bat", extension: ".bat", content: "@echo off\nping 127.0.0.1" };
    commands.writeScript(dir, cmd);

    // Success simulation
    const mockSuccessExec = (_exe, _args, _opts, callback) => callback(null, "", "");
    const resSuccess = await commands.run(dir, cmd, { execFile: mockSuccessExec });
    assert.equal(resSuccess.ok, true);

    // UAC denied simulation (code 1223)
    const errDenied = new Error("Command failed");
    errDenied.code = 1223;
    const mockDeniedExec = (_exe, _args, _opts, callback) => callback(errDenied, "", "");
    const resDenied = await commands.run(dir, cmd, { execFile: mockDeniedExec });
    assert.equal(resDenied.ok, false);
    assert.equal(resDenied.code, "denied");
    assert.match(resDenied.error, /declined|permission/i);

    // Missing file
    commands.removeScript(dir, cmd);
    const resMissing = await commands.run(dir, cmd, { execFile: mockSuccessExec });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.code, "missing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
