import { DEFAULT_OPTIONS, DeckOptions } from "../../src/features/progress/scheduler.js";

export function protobufFields(blob: { base64: string }) {
  const bytes = Buffer.from(blob.base64, "base64"), fields = new Map<number, number | Buffer>();
  let offset = 0;
  const varint = () => {
    let result = 0, shift = 0;
    while (offset < bytes.length && shift < 70) { const byte = bytes[offset++]; result += (byte & 127) * 2 ** shift; if (!(byte & 128)) return result; shift += 7; }
    throw new Error("Invalid Anki option encoding");
  };
  while (offset < bytes.length) {
    const tag = varint(), field = tag >> 3, wire = tag & 7;
    if (wire === 0) fields.set(field, varint());
    else if (wire === 5) { if (offset + 4 > bytes.length) throw new Error("Truncated Anki options"); fields.set(field, bytes.readFloatLE(offset)); offset += 4; }
    else if (wire === 2) { const length = varint(); if (offset + length > bytes.length) throw new Error("Truncated Anki options"); fields.set(field, bytes.subarray(offset, offset + length)); offset += length; }
    else if (wire === 1) offset += 8;
    else throw new Error("Unsupported Anki option encoding");
  }
  return fields;
}
export function deckOptions(blob: { base64: string }, learnAheadSeconds = 1200): DeckOptions {
  const fields = protobufFields(blob), number = (key: number, fallback = 0) => Number(fields.get(key) ?? fallback);
  const steps = (key: number) => { const bytes = fields.get(key) as Buffer | undefined; if (!bytes) return []; if (bytes.length % 4) throw new Error("Invalid learning steps"); return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4)); };
  return { ...DEFAULT_OPTIONS, learningSteps: steps(1), relearningSteps: steps(2), learnAheadSeconds,
    newPerDay: number(9), reviewsPerDay: number(10), initialEase: number(11, 2.5), easyMultiplier: number(12, 1.3),
    hardMultiplier: number(13, 1.2), lapseMultiplier: number(14), intervalMultiplier: number(15, 1), maximumInterval: number(16, 36500),
    minimumLapseInterval: number(17, 1), graduatingGood: number(18, 1), graduatingEasy: number(19, 4),
    leechSuspend: number(21) === 0, leechThreshold: number(22), buryNew: !!number(27), buryReviews: !!number(28), buryInterday: !!number(29),
    newMix: number(30), interdayMix: number(31), newOrder: number(32), reviewOrder: number(33) };
}
