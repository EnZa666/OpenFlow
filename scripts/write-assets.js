"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    raw[start] = 0;
    pixels.copy(raw, start + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(pngBytes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBytes.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBytes]);
}

function paint(size, knockOutWhite) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x < radius ? radius : (x > size - radius ? size - radius : x);
      const cy = y < radius ? radius : (y > size - radius ? size - radius : y);
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      const offset = (y * size + x) * 4;
      if (!inside) continue;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
  }
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outer = size * 0.3;
  const inner = size * 0.23;
  const dot = size * 0.045;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      if (pixels[offset + 3] === 0) continue;
      const distance = Math.hypot(x - cx, y - cy);
      const mark = (distance <= outer && distance >= inner) || distance <= dot;
      if (!mark) continue;
      pixels[offset] = 17;
      pixels[offset + 1] = 17;
      pixels[offset + 2] = 17;
    }
  }
  if (knockOutWhite) {
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 250 && pixels[i + 1] > 250 && pixels[i + 2] > 250) pixels[i + 3] = 0;
    }
  }
  return png(size, size, pixels);
}

function wav(events) {
  const rate = 22050;
  const seconds = 0.42;
  const count = Math.floor(rate * seconds);
  const samples = new Float32Array(count);
  for (const event of events) {
    const start = Math.floor(event.at * rate);
    const length = Math.floor(event.dur * rate);
    for (let i = 0; i < length && start + i < count; i += 1) {
      const env = Math.exp(-4.2 * (i / length));
      samples[start + i] += Math.sin(2 * Math.PI * event.freq * (i / rate)) * event.amp * env;
    }
  }
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const soundDir = path.join(root, "renderer", "sounds");
fs.mkdirSync(soundDir, { recursive: true });
fs.mkdirSync(path.join(root, "build"), { recursive: true });

const cues = {
  "listen-start.wav": [
    { at: 0.02, dur: 0.12, freq: 660, amp: 0.22 },
    { at: 0.14, dur: 0.16, freq: 880, amp: 0.18 },
  ],
  "listen-stop.wav": [
    { at: 0.02, dur: 0.12, freq: 880, amp: 0.18 },
    { at: 0.14, dur: 0.16, freq: 620, amp: 0.16 },
  ],
  "done.wav": [
    { at: 0.02, dur: 0.1, freq: 523, amp: 0.16 },
    { at: 0.12, dur: 0.18, freq: 784, amp: 0.18 },
  ],
  "error.wav": [
    { at: 0.02, dur: 0.22, freq: 196, amp: 0.2 },
  ],
};

for (const [name, events] of Object.entries(cues)) {
  fs.writeFileSync(path.join(soundDir, name), wav(events));
}

const icon = paint(256);
fs.writeFileSync(path.join(root, "build", "icon.png"), icon);
fs.writeFileSync(path.join(root, "build", "icon.ico"), ico(icon));
fs.writeFileSync(path.join(root, "renderer", "tray.png"), paint(32, true));
