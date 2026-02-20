import { connectDatabase } from "../src/lib/database";
import * as fs from "fs";

async function extract() {
  const db = await connectDatabase();

  const esPhrases = await db.phrasesES
    .find({}, { projection: { phrase: 1, _id: 1 } })
    .toArray();
  const dePhrases = await db.phrasesDE
    .find({}, { projection: { phrase: 1, _id: 1 } })
    .toArray();

  fs.writeFileSync(
    "_seed/phrases_for_synonyms.json",
    JSON.stringify({ esPhrases, dePhrases }, null, 2),
  );

  console.log(
    `Extracted ${esPhrases.length} ES and ${dePhrases.length} DE phrases.`,
  );
  process.exit(0);
}

extract().catch((err) => {
  console.error(err);
  process.exit(1);
});
