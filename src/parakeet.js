"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MODEL_ID = "parakeet-tdt-0.6b-v3";
const HF_BASE = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main";
const REQUIRED_FILES = [
  { name: "tokens.txt", minBytes: 1000 },
  { name: "joiner.int8.onnx", minBytes: 1000000 },
  { name: "decoder.int8.onnx", minBytes: 1000000 },
  { name: "encoder.int8.onnx", minBytes: 100000000 },
];

let recognizer = null;
let loadPromise = null;
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

function resolveModelDir(userDataPath) {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, MODEL_ID));
    candidates.push(path.join(process.resourcesPath, "models", MODEL_ID));
  }
  candidates.push(path.join(__dirname, "..", "vendor", MODEL_ID));
  if (userDataPath) {
    candidates.push(path.join(userDataPath, "models", MODEL_ID));
  }
  for (const dir of candidates) {
    if (dirHasModel(dir)) return dir;
  }
  return userDataPath
    ? path.join(userDataPath, "models", MODEL_ID)
    : path.join(__dirname, "..", "vendor", MODEL_ID);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${path.basename(destPath)} (${res.status})`);
  }
  const tmpPath = `${destPath}.${process.pid}.part`;
  const fileStream = fs.createWriteStream(tmpPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
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

async function ensureModelFiles(userDataPath) {
  const dir = resolveModelDir(userDataPath);
  if (dirHasModel(dir)) return dir;
  engineState = "installing";
  fs.mkdirSync(dir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const full = path.join(dir, file.name);
    let valid = false;
    try {
      valid = fs.existsSync(full) && fs.statSync(full).size >= file.minBytes;
    } catch {
      valid = false;
    }
    if (!valid) {
      await downloadFile(`${HF_BASE}/${file.name}`, full);
    }
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
  resolveModelDir,
  dirHasModel,
  ensureModelFiles,
  decodeWavPcm16,
  startBackground,
  stopBackground,
  transcribeWav,
  getStatus,
};
