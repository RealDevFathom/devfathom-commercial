import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";

const sampleRate = 44100;
const duration = 24;
const samples = sampleRate * duration;
const data = new Int16Array(samples * 2);
const chord = [55, 82.41, 110, 164.81];

const smooth = (x) => x * x * (3 - 2 * x);
const env = (t, at, len) => {
  const p = (t - at) / len;
  if (p < 0 || p > 1) return 0;
  return Math.sin(Math.PI * p) ** 1.8;
};

for (let i = 0; i < samples; i++) {
  const t = i / sampleRate;
  const fadeIn = smooth(Math.min(1, t / 1.2));
  const fadeOut = smooth(Math.min(1, (duration - t) / 1.8));
  const master = fadeIn * fadeOut;

  let signal = 0;
  chord.forEach((f, index) => {
    const drift = 1 + Math.sin(t * 0.19 + index) * 0.0018;
    signal += Math.sin(2 * Math.PI * f * drift * t + index * 0.7) * (0.052 / (index + 1));
  });

  const pulsePhase = (t * 1.5) % 1;
  const pulse = Math.exp(-pulsePhase * 8.5);
  signal += Math.sin(2 * Math.PI * 55 * t) * pulse * 0.13;

  for (const beat of [3.7, 9.0, 13.7, 18.4]) {
    const e = env(t, beat, 0.9);
    const sweep = 130 - (t - beat) * 90;
    signal += Math.sin(2 * Math.PI * Math.max(50, sweep) * (t - beat)) * e * 0.12;
  }

  for (const tick of [2.1, 4.3, 7.1, 10.2, 12.7, 15.5, 18.1, 20.2]) {
    const e = env(t, tick, 0.075);
    signal += Math.sin(2 * Math.PI * 1300 * t) * e * 0.035;
  }

  const air = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  signal += air * 0.006;
  signal *= master;

  const left = Math.max(-1, Math.min(1, signal * (0.96 + Math.sin(t * 0.23) * 0.04)));
  const right = Math.max(-1, Math.min(1, signal * (0.96 - Math.sin(t * 0.23) * 0.04)));
  data[i * 2] = Math.round(left * 32767);
  data[i * 2 + 1] = Math.round(right * 32767);
}

const bytesPerSample = 2;
const channels = 2;
const dataSize = data.length * bytesPerSample;
const buffer = Buffer.alloc(44 + dataSize);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
buffer.writeUInt16LE(channels * bytesPerSample, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);

for (let i = 0; i < data.length; i++) buffer.writeInt16LE(data[i], 44 + i * 2);

const output = resolve("public/soundtrack.wav");
mkdirSync(dirname(output), {recursive: true});
writeFileSync(output, buffer);
console.log(`Generated ${output} (${duration}s stereo)`);
