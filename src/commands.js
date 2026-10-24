"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

// Script types a command can have. Name, type and extension are fixed once a command exists.
const TYPES = {
  bat: { id: "bat", label: "Bat", extension: ".bat" },
  powershell: { id: "powershell", label: "PowerShell", extension: ".ps1" },
  cmd: { id: "cmd", label: "CMD", extension: ".cmd" },
};

const MAX_NAME = 48;
const MAX_CONTENT = 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Letters, digits, space, underscore and hyphen only: no path separators, dots, quotes or shell metacharacters.
const ALLOWED = /^[\p{L}\p{N} _-]+$/u;

function validateName(input, existing) {
  const name = String(input == null ? "" : input);
  if (!name.trim()) return "Please enter a name.";
  if (name !== name.trim()) return "The name must not start or end with a space.";
  if (name.length > MAX_NAME) return `The name may have at most ${MAX_NAME} characters.`;
  if (!ALLOWED.test(name)) return "Use only letters, numbers, spaces, hyphens and underscores.";
  if (RESERVED.test(name)) return "This name is reserved by Windows.";
  const lower = name.toLowerCase();
  if ((existing || []).some((row) => String(row.name).toLowerCase() === lower)) return "A command with this name already exists.";
  return "";
}

function typeOf(type) {
  return Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
}

function fileNameFor(command) {
  return `${command.name}${command.extension}`;
}

// Resolves the script path and refuses anything that would leave the commands folder.
function scriptPath(dir, command) {
  const type = typeOf(command && command.type);
  if (!type || command.extension !== type.extension) throw new Error("Unknown command type.");
  const error = validateName(command.name, []);
  if (error) throw new Error(error);
  const root = path.resolve(dir);
  const file = path.resolve(root, fileNameFor(command));
  if (path.dirname(file) !== root) throw new Error("Invalid script path.");
  return file;
}

function normalizeContent(content) {
  return String(content == null ? "" : content).replace(/\r\n|\r|\n/g, "\r\n");
}

function writeScript(dir, command) {
  const file = scriptPath(dir, command);
  fs.mkdirSync(dir, { recursive: true });
  const body = normalizeContent(command.content);
  // PowerShell 5 only reads UTF-8 reliably with a BOM.
  const text = command.type === "powershell" ? `\uFEFF${body}` : body;
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function removeScript(dir, command) {
  try {
    fs.rmSync(scriptPath(dir, command), { force: true });
  } catch {
    // Nothing to remove.
  }
}

// Fixed launcher: the script path and arguments reach PowerShell only through environment
// variables, never through string interpolation.
const LAUNCHER = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  Start-Process -FilePath $env:OPENFLOW_CMD_EXE -ArgumentList $env:OPENFLOW_CMD_ARGS -Verb RunAs -WorkingDirectory $env:OPENFLOW_CMD_DIR",
  "} catch {",
  "  if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.Message -match 'canceled by the user|abgebrochen') { exit 1223 }",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

function launchSpec(command, file) {
  const dir = path.dirname(file);
  if (command.type === "powershell") {
    return {
      exe: "powershell.exe",
      args: `-NoProfile -ExecutionPolicy Bypass -NoExit -File "${file}"`,
      dir,
    };
  }
  // /d skips AutoRun, /k keeps the console open so output stays visible.
  return { exe: "cmd.exe", args: `/d /k ""${file}""`, dir };
}

function run(dir, command, options) {
  const exec = (options && options.execFile) || execFile;
  return new Promise((resolve) => {
    let file;
    try {
      file = scriptPath(dir, command);
    } catch (error) {
      resolve({ ok: false, code: "invalid", error: error.message });
      return;
    }
    if (!fs.existsSync(file)) {
      resolve({ ok: false, code: "missing", error: `The script file for "${command.name}" is missing. Open the command in OpenFlow and save it again to restore it.` });
      return;
    }
    const spec = launchSpec(command, file);
    exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LAUNCHER],
      {
        windowsHide: true,
        env: { ...process.env, OPENFLOW_CMD_EXE: spec.exe, OPENFLOW_CMD_ARGS: spec.args, OPENFLOW_CMD_DIR: spec.dir },
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true });
          return;
        }
        if (error.code === 1223) {
          resolve({ ok: false, code: "denied", error: `Administrator permission was declined, "${command.name}" was not run.` });
          return;
        }
        const detail = String(stderr || error.message || "").trim().split(/\r?\n/)[0];
        resolve({ ok: false, code: "failed", error: `"${command.name}" could not be started${detail ? `: ${detail}` : "."}` });
      },
    );
  });
}

module.exports = { TYPES, MAX_NAME, MAX_CONTENT, validateName, typeOf, scriptPath, writeScript, removeScript, launchSpec, run, normalizeContent };
