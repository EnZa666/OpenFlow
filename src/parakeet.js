"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MODEL_ID = "parakeet-tdt-0.6b-v3";
const HF_BASE = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main";
const REQUIRED_FILES = [
  { name: "tokens.txt", minBytes: 1000, expectedBytes: 93939 },
  { name: "joiner.int8.onnx", minBytes: 1000000, expectedBytes: 6355277 },
  { name: "decoder.int8.onnx", minBytes: 1000000, expectedBytes: 11845275 },
  { name: "encoder.int8.onnx", minBytes: 100000000, expectedBytes: 652184281 },
];
const TOTAL_EXPECTED_BYTES = REQUIRED_FILES.reduce((sum, file) => sum + file.expectedBytes, 0);

let recognizer = null;
let loadPromise = null;
let installPromise = null;
let engineState = "stopped";
let lastError = "";
let activeModelDir = "";

function dirHasModel(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return REQUIRED_FILES.every((file) => {
    const full = path.join(dir, file.name);
    if (!fs.existsSync(full)) return false;
    try {
      return fs.statSync(full).size >= file.minBytes;
    } catch {
      return false;
    }
  });
}

function candidateModelDirs(userDataPath) {
  const dirs = [];
  if (userDataPath) {
    dirs.push(path.join(userDataPath, "models", MODEL_ID));
  }
  if (process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "OpenFlow", "models", MODEL_ID));
    dirs.push(path.join(process.env.LOCALAPPDATA, "openflow", "models", MODEL_ID));
  }
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, "openflow", "models", MODEL_ID));
    dirs.push(path.join(process.env.APPDATA, "OpenFlow", "models", MODEL_ID));
  }
  dirs.push(path.join(__dirname, "..", "vendor", MODEL_ID));
  return [...new Set(dirs)];
}

function mirrorModelHardlinks(sourceDir, targetDir) {
  if (!sourceDir || !targetDir) return;
  try {
    if (path.resolve(sourceDir).toLowerCase() === path.resolve(targetDir).toLowerCase()) return;
    if (dirHasModel(targetDir)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of REQUIRED_FILES) {
      const src = path.join(sourceDir, file.name);
      const dst = path.join(targetDir, file.name);
      if (fs.existsSync(dst)) {
        try {
          if (fs.statSync(dst).size >= file.minBytes) continue;
          fs.unlinkSync(dst);
        } catch {}
      }
      try {
        fs.linkSync(src, dst);
      } catch {
        // Ignore if cross-device; sourceDir is already valid
      }
    }
  } catch {}
}

function resolveModelDir(userDataPath) {
  const candidates = candidateModelDirs(userDataPath);
  for (const dir of candidates) {
    if (dirHasModel(dir)) {
      if (process.env.LOCALAPPDATA) {
        mirrorModelHardlinks(dir, path.join(process.env.LOCALAPPDATA, "OpenFlow", "models", MODEL_ID));
      }
      if (userDataPath) {
        mirrorModelHardlinks(dir, path.join(userDataPath, "models", MODEL_ID));
      }
      return dir;
    }
  }
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenFlow", "models", MODEL_ID);
  }
  if (userDataPath) {
    return path.join(userDataPath, "models", MODEL_ID);
  }
  return path.join(__dirname, "..", "vendor", MODEL_ID);
}

function isModelInstalled(userDataPath) {
  return candidateModelDirs(userDataPath).some((dir) => dirHasModel(dir));
}

async function downloadFile(url, destPath, onChunkBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${path.basename(destPath)} (${res.status})`);
  }
  const contentLength = Number(res.headers.get("content-length")) || 0;
  const tmpPath = `${destPath}.${process.pid}.part`;
  const fileStream = fs.createWriteStream(tmpPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        if (typeof onChunkBytes === "function") {
          onChunkBytes(value.byteLength, contentLength);
        }
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise((resolve) => fileStream.once("drain", resolve));
        }
      }
    }
    await new Promise((resolve, reject) => {
      fileStream.end((err) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(tmpPath, destPath);
  } catch (error) {
    try { fileStream.destroy(); } catch {}
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

async function ensureModelFiles(userDataPath, onProgress) {
  const dir = resolveModelDir(userDataPath);
  if (dirHasModel(dir)) {
    if (typeof onProgress === "function") {
      const totalMb = Number((TOTAL_EXPECTED_BYTES / (1024 * 1024)).toFixed(1));
      onProgress({
        downloadedBytes: TOTAL_EXPECTED_BYTES,
        totalBytes: TOTAL_EXPECTED_BYTES,
        downloadedMb: totalMb,
        totalMb,
        percent: 100,
        done: true,
      });
    }
    return dir;
  }

  engineState = "installing";
  fs.mkdirSync(dir, { recursive: true });

  let completedBytes = 0;
  const totalBytes = TOTAL_EXPECTED_BYTES;
  const report = (extraBytes = 0, currentFile = "") => {
    if (typeof onProgress !== "function") return;
    const current = Math.min(totalBytes, completedBytes + extraBytes);
    const downloadedMb = Number((current / (1024 * 1024)).toFixed(1));
    const totalMb = Number((totalBytes / (1024 * 1024)).toFixed(1));
    const percent = Math.max(0, Math.min(100, Math.round((current / totalBytes) * 100)));
    onProgress({
      downloadedBytes: current,
      totalBytes,
      downloadedMb,
      totalMb,
      percent,
      currentFile,
      done: false,
    });
  };

  report(0, "");

  for (const file of REQUIRED_FILES) {
    const full = path.join(dir, file.name);
    let existingSize = 0;
    let valid = false;
    try {
      if (fs.existsSync(full)) {
        existingSize = fs.statSync(full).size;
        valid = existingSize >= file.minBytes;
      }
    } catch {
      valid = false;
    }
    if (valid) {
      completedBytes += file.expectedBytes;
      report(0, file.name);
      continue;
    }
    let fileDownloaded = 0;
    let lastEmit = 0;
    await downloadFile(`${HF_BASE}/${file.name}`, full, (chunkLen) => {
      fileDownloaded += chunkLen;
      const now = Date.now();
      if (now - lastEmit >= 60) {
        lastEmit = now;
        report(fileDownloaded, file.name);
      }
    });
    const downloadedSize = fs.statSync(full).size;
    if (downloadedSize < file.minBytes) {
      fs.unlinkSync(full);
      throw new Error(`Downloaded ${file.name} appears truncated (${downloadedSize} bytes).`);
    }
    completedBytes += file.expectedBytes;
    report(0, file.name);
  }

  if (process.env.LOCALAPPDATA) {
    mirrorModelHardlinks(dir, path.join(process.env.LOCALAPPDATA, "OpenFlow", "models", MODEL_ID));
  }
  if (userDataPath) {
    mirrorModelHardlinks(dir, path.join(userDataPath, "models", MODEL_ID));
  }

  if (typeof onProgress === "function") {
    const totalMb = Number((totalBytes / (1024 * 1024)).toFixed(1));
    onProgress({
      downloadedBytes: totalBytes,
      totalBytes,
      downloadedMb: totalMb,
      totalMb,
      percent: 100,
      done: true,
    });
  }
  return dir;
}

function decodeWavPcm16(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 44) return { samples: new Float32Array(0), sampleRate: 16000 };
  const riff = bytes.toString("ascii", 0, 4);
  const wave = bytes.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV audio format for Parakeet v3.");
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = 44;
  let dataLength = bytes.length - 44;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (chunkId === "fmt " && bodyOffset + 16 <= bytes.length) {
      channels = Math.max(1, bytes.readUInt16LE(bodyOffset + 2));
      sampleRate = bytes.readUInt32LE(bodyOffset + 4) || 16000;
      bitsPerSample = bytes.readUInt16LE(bodyOffset + 14) || 16;
    } else if (chunkId === "data") {
      dataStart = bodyOffset;
      dataLength = Math.min(chunkSize, bytes.length - bodyOffset);
      break;
    }
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }
  if (bitsPerSample !== 16 || dataLength <= 0) {
    return { samples: new Float32Array(0), sampleRate };
  }
  const frameSize = channels * 2;
  const frameCount = Math.floor(dataLength / frameSize);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const pos = dataStart + i * frameSize;
    const pcm = bytes.readInt16LE(pos);
    samples[i] = pcm < 0 ? pcm / 32768 : pcm / 32767;
  }
  return { samples, sampleRate };
}

function startBackground(userDataPath) {
  if (process.env.OPENFLOW_SMOKE === "1") {
    engineState = "ready";
    return Promise.resolve(null);
  }
  if (recognizer) {
    engineState = "ready";
    return Promise.resolve(recognizer);
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      lastError = "";
      const modelDir = await ensureModelFiles(userDataPath);
      activeModelDir = modelDir;
      engineState = "loading";
      const sherpa = require("sherpa-onnx-node");
      const threads = Math.max(1, Math.min(4, Math.floor((os.cpus() || []).length / 2) || 2));
      const config = {
        featConfig: {
          sampleRate: 16000,
          featureDim: 80,
        },
        modelConfig: {
          transducer: {
            encoder: path.join(modelDir, "encoder.int8.onnx"),
            decoder: path.join(modelDir, "decoder.int8.onnx"),
            joiner: path.join(modelDir, "joiner.int8.onnx"),
          },
          tokens: path.join(modelDir, "tokens.txt"),
          numThreads: threads,
          provider: "cpu",
          debug: 0,
          modelType: "nemo_transducer",
        },
      };
      recognizer = await sherpa.OfflineRecognizer.createAsync(config);
      engineState = "ready";
      return recognizer;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      engineState = "error";
      throw error;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

function stopBackground() {
  recognizer = null;
  loadPromise = null;
  engineState = "stopped";
}

async function transcribeWav(wavBuffer, userDataPath) {
  const inst = await startBackground(userDataPath);
  if (!inst) return { text: "", language: "" };
  const { samples, sampleRate } = decodeWavPcm16(wavBuffer);
  if (!samples.length) return { text: "", language: "" };
  const stream = inst.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  const result = await inst.decodeAsync(stream);
  const text = result && typeof result.text === "string" ? result.text.trim() : "";
  const language = result && typeof result.lang === "string" ? result.lang.replace(/^<\|?|\|?>$/g, "") : "";
  return { text, language };
}

function getStatus(userDataPath) {
  const dir = activeModelDir || resolveModelDir(userDataPath);
  return {
    model: MODEL_ID,
    installed: dirHasModel(dir),
    state: engineState,
    error: lastError,
  };
}

module.exports = {
  MODEL_ID,
  TOTAL_EXPECTED_BYTES,
  resolveModelDir,
  dirHasModel,
  isModelInstalled,
  ensureModelFiles,
  decodeWavPcm16,
  startBackground,
  stopBackground,
  transcribeWav,
  getStatus,
};
