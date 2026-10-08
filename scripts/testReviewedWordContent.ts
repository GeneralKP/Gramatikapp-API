import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { nativeWordPair } from "../src/features/progress/nativeWordPairs.js";
import { GrammaticalCategory, type Word, type WordStudyContent } from "../src/features/words/words.types.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";

const now = new Date("2026-10-08T00:00:00Z");
const de: Word = { _id: new ObjectId(), word: "warten", gramaticalCategories: [GrammaticalCategory.VERB], examples: [], contexts: [], createdAt: now };
const es: Word = { ...de, _id: new ObjectId(), word: "esperar" };
const original: UserProgress = { _id: new ObjectId(), userId: new ObjectId(), itemId: new ObjectId(), itemType: "WORD", failureIndex: 4,
  isNew: true, ease: 2.5, interval: 0, repetitions: 0, nextDueDate: now, lastReviewed: null, createdAt: now };
const content: WordStudyContent = { version: 1, german: "auf jemanden warten", spanish: "a alguien esperar",
  notes: "hat gewartet\nich wartete\nwarte!, wartet!",
  examples: ["Ich warte auf dich. (Te espero.)", "Wir haben auf unseren Freund gewartet. (Esperamos a nuestro amigo.)"], auditedAt: now };
const fallback = nativeWordPair(original, es, de);
const reviewed = nativeWordPair(original, es, de, content);
assert.equal(de.word, "warten");
assert.equal(es.word, "esperar");
assert.equal(reviewed[0].card!.prompt, content.german);
assert.equal(reviewed[0].card!.answer, content.spanish);
assert.equal(reviewed[1].card!.prompt, content.spanish);
assert.equal(reviewed[1].card!.answer, content.german);
assert.deepEqual(reviewed[1].card!.acceptedAnswers, [content.german]);
assert.equal(reviewed[1].card!.notes, content.notes);
assert.deepEqual(reviewed[1].card!.examples, content.examples);
for (let i = 0; i < reviewed.length; i++) {
  const { card: beforeCard, createdAt: beforeTime, ...before } = fallback[i];
  const { card: afterCard, createdAt: afterTime, ...after } = reviewed[i];
  assert.deepEqual(after, before, "card wording must not change identity, mistakes or scheduling");
  for (const key of ["source", "sourceCardId", "sourceNoteGuid", "direction", "deck", "tags"] as const) assert.deepEqual(afterCard![key], beforeCard![key]);
}
assert.equal(reviewed[1].createdAt, original.createdAt);
assert.equal(fallback[0].card!.prompt, "warten", "unreviewed records retain the compatible fallback");
assert.equal(nativeWordPair(original, es, de, { ...content, version: 2 } as unknown as WordStudyContent)[0].card!.prompt, "warten", "unknown content versions retain the compatible fallback");
const annotated = nativeWordPair(original, { ...es, word: "ocurrir" }, { ...de, word: "ereignen" }, { ...content, german: "sich ereignen", spanish: "ocurrir (rflxv.) (formal)", notes: "hat sich ereignet\nes ereignete sich", examples: ["Der Unfall hat sich gestern ereignet. (El accidente ocurrió ayer.)", "Dort ereignete sich ein Unglück. (Allí ocurrió una desgracia.)"] });
assert.equal(annotated[0].card!.answer, "ocurrir (rflxv.) (formal)", "display annotations remain visible");
assert.deepEqual(annotated[0].card!.acceptedAnswers, ["ocurrir"], "display annotations are not part of the typed answer");
assert.deepEqual(annotated[1].card!.acceptedAnswers, ["sich ereignen"]);
console.log("PASS reviewed directional content, unchanged dictionary spelling and preserved card/progress identity");
