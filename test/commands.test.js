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
  assert.equal(c1.runAsAdmin, false);
  assert.ok(c1.created_at);
  assert.ok(c1.modified_at);

  // Duplicate name rejected
  assert.throws(() => store.createCommand({ name: "restart network", type: "bat", content: "" }));

  // Add command to bubble elements
  store.updateSettings({ bubbleElements: ["voice", `cmd:${c1.id}`, "note"] });
  assert.deepEqual(store.getSettings().bubbleElements, ["voice", `cmd:${c1.id}`, "note"]);

  // Save command updates content, modified_at, and runAsAdmin flag
  const updated = store.saveCommand({ id: c1.id, content: "Restart-NetAdapter -Name 'Wi-Fi'", runAsAdmin: true });
  assert.equal(updated.content, "Restart-NetAdapter -Name 'Wi-Fi'");
  assert.equal(updated.name, "Restart Network");
  assert.equal(updated.type, "powershell");
  assert.equal(updated.runAsAdmin, true);

  // Listing commands preserves runAsAdmin
  const list = store.listCommands();
  assert.equal(list.length, 1);
  assert.equal(list[0].runAsAdmin, true);

  // createCommand with explicit runAsAdmin: true
  const c2 = store.createCommand({ name: "Admin Task", type: "bat", content: "@echo off", runAsAdmin: true });
  assert.equal(c2.runAsAdmin, true);

  // Deleting command removes it from store AND strips cmd:<id> from bubbleElements
  const removed = store.deleteCommand(c1.id);
  assert.equal(removed.id, c1.id);
  store.deleteCommand(c2.id);
  assert.equal(store.listCommands().length, 0);
  assert.deepEqual(store.getSettings().bubbleElements, ["voice", "note"]);
});

test("run execution handles success, missing script, and user cancellation (UAC 1223)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-cmd-run-"));
  try {
    const cmd = { name: "PingTest", type: "bat", extension: ".bat", content: "@echo off\nping 127.0.0.1" };
    commands.writeScript(dir, cmd);

    // Success simulation (non-admin by default, OPENFLOW_CMD_RUNAS is "0")
    let capturedEnv = null;
    const mockSuccessExec = (_exe, _args, opts, callback) => {
      capturedEnv = opts.env;
      callback(null, "", "");
    };
    const resSuccess = await commands.run(dir, cmd, { execFile: mockSuccessExec });
    assert.equal(resSuccess.ok, true);
    assert.equal(capturedEnv.OPENFLOW_CMD_RUNAS, "0");

    // Non-admin run with 1223 error is treated as generic failure (not UAC denied)
    const errDenied = new Error("Command failed");
    errDenied.code = 1223;
    const mockDeniedExec = (_exe, _args, _opts, callback) => callback(errDenied, "", "");
    const resNonAdminDenied = await commands.run(dir, cmd, { execFile: mockDeniedExec });
    assert.equal(resNonAdminDenied.ok, false);
    assert.equal(resNonAdminDenied.code, "failed");

    // Admin run (runAsAdmin: true) passes OPENFLOW_CMD_RUNAS="1" and treats 1223 as UAC "denied"
    const adminCmd = { ...cmd, runAsAdmin: true };
    const mockAdminSuccessExec = (_exe, _args, opts, callback) => {
      capturedEnv = opts.env;
      callback(null, "", "");
    };
    const resAdminSuccess = await commands.run(dir, adminCmd, { execFile: mockAdminSuccessExec });
    assert.equal(resAdminSuccess.ok, true);
    assert.equal(capturedEnv.OPENFLOW_CMD_RUNAS, "1");

    const resAdminDenied = await commands.run(dir, adminCmd, { execFile: mockDeniedExec });
    assert.equal(resAdminDenied.ok, false);
    assert.equal(resAdminDenied.code, "denied");
    assert.match(resAdminDenied.error, /declined|permission/i);

    // Missing file
    commands.removeScript(dir, cmd);
    const resMissing = await commands.run(dir, cmd, { execFile: mockSuccessExec });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.code, "missing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("existing commands without runAsAdmin count as false", () => {
  const tmp = path.join(os.tmpdir(), `of-legacy-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      commands: [
        { id: "legacy-1", name: "Old Script", type: "bat", extension: ".bat", content: "@echo off", created_at: "2026-01-01T00:00:00.000Z", modified_at: "2026-01-01T00:00:00.000Z" }
      ]
    }), "utf8");
    const store = createStore(tmp);
    const cmd = store.getCommand("legacy-1");
    assert.equal(cmd.runAsAdmin, false);
    const list = store.listCommands();
    assert.equal(list[0].runAsAdmin, false);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test("COMMAND_ICONS collection contains 20 valid icons and normalizes invalid icons", () => {
  assert.equal(commands.COMMAND_ICONS.length, 20);
  assert.ok(commands.COMMAND_ICONS.includes("terminal"));
  assert.ok(commands.COMMAND_ICONS.includes("rocket"));
  assert.ok(commands.COMMAND_ICONS.includes("bolt"));
  assert.equal(commands.normalizeIcon("rocket"), "rocket");
  assert.equal(commands.normalizeIcon("nonexistent"), "terminal");
  assert.equal(commands.normalizeIcon(null), "terminal");
});

test("store manages command icons with default terminal icon and update support", () => {
  const store = createStore(":memory:");
  const c1 = store.createCommand({ name: "Default Icon Cmd", type: "powershell", content: "Write-Host 1" });
  assert.equal(c1.icon, "terminal");

  const c2 = store.createCommand({ name: "Rocket Cmd", type: "bat", content: "@echo off", icon: "rocket" });
  assert.equal(c2.icon, "rocket");

  const updated = store.saveCommand({ id: c1.id, icon: "bolt" });
  assert.equal(updated.icon, "bolt");

  const fromGet = store.getCommand(c1.id);
  assert.equal(fromGet.icon, "bolt");
});
