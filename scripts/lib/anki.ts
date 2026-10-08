import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

export const stableId = (key: string) => new ObjectId(createHash("sha256").update(key).digest("hex").slice(0, 24));
export const normalizeWord = (value: string, german = false) => value.normalize("NFC").trim().replace(/\s+/g, " ").replace(german ? /^(der|die|das)\s+/i : /$^/, "").toLocaleLowerCase("de");

export function collectionConfig(entries: { KEY?: string; key?: string; val: { base64: string } }[]) {
  return Object.fromEntries(entries.map(entry => {
    // SQLite exports preserve the modern schema's uppercase KEY column.
    const key = entry.KEY ?? entry.key;
    if (!key) throw new Error("Anki configuration entry has no key");
    return [key, JSON.parse(Buffer.from(entry.val.base64, "base64").toString("utf8"))];
  }));
}

export function germanLexemeKey(text: string, forms: any = {}, categories: string[] = []) {
  const gender = text.match(/^(der|die|das)\s+/i)?.[1].toLowerCase() || ({ der: "der", die: "die", das: "das", masculine: "der", feminine: "die", neuter: "das", m: "der", f: "die", n: "das" })[(forms.gender || "").toLowerCase()];
  const word = text.replace(/^(der|die|das)\s+/i, "");
  const unspecifiedNoun = categories.includes("NOUN") || ((!categories.length || categories.includes("UNKNOWN")) && word[0] !== word[0]?.toLowerCase());
  return `${normalizeWord(text, true)}|${gender || (unspecifiedNoun ? "noun" : "other")}`;
}

export function plainText(html: string): string {
  // Source HTML is inert text. Remove active content before removing other tags.
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/(div|p|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity])
    .replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function templateFormats(config: { base64: string }) {
  const bytes = Buffer.from(config.base64, "base64");
  let offset = 0;
  const varint = () => { let value = 0, shift = 0; while (offset < bytes.length && shift < 70) { const byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return value; shift += 7; } throw new Error("Invalid template protobuf"); };
  const result: Record<number, string> = {};
  while (offset < bytes.length) {
    const tag = varint(), wire = tag & 7, field = tag >> 3;
    if (wire === 2) { const length = varint(); if (offset + length > bytes.length) throw new Error("Truncated template"); if (field === 1 || field === 2) result[field] = bytes.subarray(offset, offset + length).toString("utf8"); offset += length; }
    else if (wire === 0) varint();
    else if (wire === 5) offset += 4;
    else if (wire === 1) offset += 8;
    else throw new Error("Unsupported template encoding");
  }
  return { question: result[1] || "", answer: result[2] || "" };
}

export function clozeText(text: string, ordinal: number) {
  const answers: string[] = [];
  const prompt = text.replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (_, n, content) => {
    const [answer, hint] = content.split("::");
    if (Number(n) === ordinal + 1) { answers.push(answer); return hint ? `[${hint}]` : "[…]"; }
    return answer;
  });
  const full = text.replace(/\{\{c\d+::([\s\S]*?)\}\}/g, (_, content) => content.split("::")[0]);
  if (!answers.length) throw new Error("Cloze card has no matching deletion");
  return { prompt, answer: answers.join(" "), full };
}

// Anki review/day-learning due values count calendar days since the collection's
// creation date. Intraday learning uses Unix seconds; new cards use an ordering number.
export function dueDate(card: any, collection: any, config: any, timeZone: string, now: Date): Date {
  if (card.queue === 0) return now;
  const due = card.odid && card.odue ? card.odue : card.due;
  if (card.queue === 1 || due > 1_000_000_000) return new Date(due * 1000);
  const origin = new Date((collection.crt - (config.creationOffset ?? 0) * 60) * 1000);
  const date = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth(), origin.getUTCDate() + due, config.rollover ?? 4));
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const zoneOffset = (stamp: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(stamp).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - stamp.getTime();
  };
  let stamp = new Date(date.getTime() - zoneOffset(date));
  stamp = new Date(date.getTime() - zoneOffset(stamp));
  return stamp;
}

export function noteContent(note: any, tables: any) {
  const fields = note.flds.split("\u001f").map(plainText);
  if (fields.length !== 4 || !fields[0] || !fields[1]) throw new Error(`Unsupported/empty fields for note ${note.guid}`);
  const fieldNames = tables.fields.filter((f: any) => f.ntid === note.mid).sort((a: any, b: any) => a.ord - b.ord).map((f: any) => f.name);
  const isCloze = fieldNames[0] === "Texto";
  if (!isCloze && fieldNames.join("|") !== "Anverso|Reverso|Notas|Ejemplos") throw new Error(`Unsupported note type ${note.mid}`);
  const german = isCloze ? clozeText(fields[0], 0).full : fields[0];
  const article = !isCloze ? german.match(/^(der|die|das)\s+/i)?.[1].toLowerCase() : undefined;
  const noteLines = fields[2].split("\n").filter(Boolean);
  const forms: Record<string, string> = {};
  if (article) { forms.gender = article; if (noteLines[0]) forms.plural = noteLines[0].replace(/^die\s+/i, ""); }
  else if (/^(hat|ist|haben|sein)\s/i.test(noteLines[0] || "")) {
    forms.perfect = noteLines[0];
    if (noteLines[1]) forms.past = noteLines[1];
    if (noteLines[2]?.includes("!")) forms.imperativ = noteLines[2];
  }
  // Correct this mixed Spanish/German source typo in learning content. The
  // original note fields remain untouched in ANKI_NOTES and the export.
  // Both clients number array entries. Anki's exported list markers are not
  // part of the sentence; archived fields remain untouched.
  const examples = fields[3].split("\n").filter(Boolean).map(example => example.replace(/^\d+[.)]\s*/, "").replace(/\bkann sie den Lärm nicht ignorar\b/g, "kann sie den Lärm nicht ignorieren"));
  const deExamples: string[] = [], esExamples: string[] = [];
  for (const example of examples) {
    const pair = example.replace(/^\d+[.)]\s*/, "").match(/^([\s\S]+?)\s*\(([^()]*)\)\s*$/);
    deExamples.push(pair ? pair[1] : example.replace(/^\d+[.)]\s*/, ""));
    esExamples.push(pair ? pair[2] : "");
  }
  return { fields, german, spanish: fields[1], notes: fields[2], examples, deExamples, esExamples, forms, isCloze,
    categories: article ? ["NOUN"] : forms.perfect ? ["VERB"] : ["UNKNOWN"] };
}

export function studyCard(card: any, note: any, tables: any, content: ReturnType<typeof noteContent>) {
  const template = tables.templates.find((t: any) => t.ntid === note.mid && t.ord === (content.isCloze ? 0 : card.ord));
  if (!template) throw new Error(`Missing template for card ${card.id}`);
  const format = templateFormats(template.config);
  let direction: "CLOZE" | "ES_DE" | "DE_ES", prompt: string, answer: string;
  if (content.isCloze && format.question.includes("{{cloze:Texto}}")) {
    direction = "CLOZE";
    ({ prompt, answer } = clozeText(content.fields[0], card.ord));
  } else if (format.question.trim() === "{{Anverso}}") { direction = "DE_ES"; prompt = content.german; answer = content.spanish; }
  else if (format.question.includes("{{Reverso}}") && format.question.includes("{{type:Anverso}}")) { direction = "ES_DE"; prompt = content.spanish; answer = content.german; }
  else throw new Error(`Unsupported card template for ${card.id}; refusing a lossy import`);
  const acceptedAnswers = [answer];
  const withoutAnnotations = (value: string) => value.replace(/\([^()]*\)/g, "").replace(/\s+/g, " ").trim();
  if (direction !== "CLOZE") {
    const plain = withoutAnnotations(answer);
    if (plain) acceptedAnswers.push(plain);
    if (direction === "DE_ES" && answer.includes("/")) {
      for (const alternative of answer.split(/\s*\/\s*/)) {
        if (alternative.trim()) acceptedAnswers.push(alternative.trim());
        if (withoutAnnotations(alternative)) acceptedAnswers.push(withoutAnnotations(alternative));
      }
    }
  }
  return { source: "ANKI" as const, sourceCardId: String(card.id), sourceNoteGuid: note.guid, direction, prompt, answer, acceptedAnswers: [...new Set(acceptedAnswers)],
    notes: content.notes, examples: content.examples, deck: (tables.decks.find((d: any) => d.id === (card.odid || card.did))?.name || "").replace(/\u001f/g, "::"), tags: note.tags.trim().split(/\s+/).filter(Boolean) };
}
