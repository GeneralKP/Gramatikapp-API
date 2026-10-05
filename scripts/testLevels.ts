import "dotenv/config";
import assert from "node:assert/strict";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { typeDefs, resolvers } from "../src/graphql/schema.js";
import { CEFR_LEVELS, validateClassifications } from "../src/features/levels/levels.js";
import { catalogPipeline } from "../src/features/levels/catalogQuery.js";

assert.deepEqual(validateClassifications({ entries: [{ id: "1", level: "A1.1" }, { id: "2", level: "C2.2" }] }, ["1", "2"]).map(e => e.level), ["A1.1", "C2.2"]);
for (const entries of [[{ id: "1", level: "A1.1" }], [{ id: "1", level: "A1.1" }, { id: "1", level: "B2.2" }], [{ id: "1", level: "Z2.2" }, { id: "2", level: "C2.2" }], [{ id: "unknown", level: "A1.1" }, { id: "2", level: "C2.2" }]]) assert.throws(() => validateClassifications({ entries }, ["1", "2"]));
assert.throws(() => catalogPipeline({ cefrLevel: "Z2.2" }, "es", "de", "word"));
assert.throws(() => catalogPipeline({ search: "x".repeat(201) }, "es", "de", "word"));
console.log("PASS CEFR bounds, exact ID coverage, duplicate/unknown IDs, invalid classifications and search limits");
if (!process.argv.includes("--unit")) {
  const db = await connectDatabase(), schema = makeExecutableSchema({ typeDefs, resolvers });
  async function call(source: string, variables = {}) { const result = await graphql({ schema, source, variableValues: variables, contextValue: { user: null } }); if (result.errors) throw new Error(result.errors.map(e => e.message).join("; ")); return result.data as any; }
  const query = `query($offset: Int, $search: String, $level: String) { wordRelations(limit: 61, offset: $offset, search: $search, cefrLevel: $level) { id main { word } translated { word cefrLevel } } }`;
  try {
    const first = (await call(query)).wordRelations, second = (await call(query, { offset: 60 })).wordRelations;
    assert.equal(first.length, 61); assert.equal(second.length, 61); assert.equal(second[0].id, first[60].id);
    assert.ok(first.slice(0, 60).every((r: any) => second.every((s: any) => r.id !== s.id)));
    const term = first[0].translated.word;
    const searched = (await call(query, { search: term })).wordRelations; assert.ok(searched.some((r: any) => r.translated.word === term));
    const filtered = (await call(query, { level: "A1.1" })).wordRelations; assert.ok(filtered.length); assert.ok(filtered.every((r: any) => r.translated.cefrLevel === "A1.1"));
    assert.equal((await call(query, { search: "^(.+)$" })).wordRelations.length, 0, "user search is a literal substring, not a regular expression");
    const phrases = (await call(`query { phraseRelations(limit: 20) { id translated { phrase cefrLevel } } }`)).phraseRelations; assert.ok(phrases.length);
    for (const mutation of [`mutation { importSeedData(jsonData: "{}") { wordsCreated } }`, `mutation { translate(text: "test") { text } }`, `mutation { addWordRelation(mainId: "000000000000000000000001", translatedId: "000000000000000000000002") { id } }`]) {
      const result = await graphql({ schema, source: mutation, contextValue: { user: null } }); assert.match(result.errors?.[0].message || "", /Unauthorized/);
    }
    for (const source of [`query { user(id: "000000000000000000000001") { email } }`, `query { userByEmail(email: "another@example.invalid") { email } }`, `mutation { syncSettings(userId: "000000000000000000000001", settings: { darkMode: true }) { id } }`]) {
      for (const user of [null, { _id: { toString: () => "000000000000000000000002" }, email: "own@example.invalid" }]) {
        const result = await graphql({ schema, source, contextValue: { user } }); assert.match(result.errors?.[0].message || "", /Unauthorized/);
      }
    }
    console.log("PASS real dictionary stable pagination, search across all entries, German CEFR filters, phrase levels and protected paid/import mutations");
    if (process.argv.includes("--verify-all")) for (const key of ["wordsDE", "wordsES", "phrasesDE", "phrasesES"] as const) {
      const total = await db[key].countDocuments(), classified = await db[key].countDocuments({ cefrLevel: { $in: [...CEFR_LEVELS] }, "cefrClassification.version": 1 });
      assert.equal(classified, total, `Every ${key} entry is classified`);
      console.log(`PASS ${key}: ${classified}/${total} classified`);
    }
  } finally { await closeDatabase(); }
}
