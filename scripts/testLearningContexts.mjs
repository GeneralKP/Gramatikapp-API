import assert from "node:assert/strict";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeTypeDefs } from "@graphql-tools/merge";
import { buildASTSchema, graphql } from "graphql";

// Use the production schema; replace only the database read with known records.
const schema = buildASTSchema(mergeTypeDefs(loadFilesSync("src/features/**/*.schema.graphql")));
for (const context of ["daily_routine", "work", "finance", "general_vocabulary", "idioms", "prepositions"]) {
  const result = await graphql({
    schema,
    source: '{ newPhrases(lang: "DE") { phrase contexts } words(lang: "DE") { word contexts } }',
    rootValue: { newPhrases: () => [{ phrase: "Ich lerne Deutsch.", contexts: [context] }], words: () => [{ word: "lernen", contexts: [context] }] },
  });
  assert.equal(result.errors, undefined, `${context} must serialize for existing imported content: ${result.errors?.map(e => e.message).join(", ")}`);
  assert.deepEqual(result.data.newPhrases[0].contexts, [context]);
  assert.deepEqual(result.data.words[0].contexts, [context]);
  console.log(`PASS imported context ${context}`);
}
