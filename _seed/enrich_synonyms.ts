import { connectDatabase } from "../src/lib/database.js";
import { ObjectId } from "mongodb";
import fs from "fs";
import { esSynonyms1 } from "./synonyms_es_1.js";
import { esSynonyms2 } from "./synonyms_es_2.js";
import { esSynonyms3 } from "./synonyms_es_3.js";
import { esSynonyms4 } from "./synonyms_es_4.js";
import { esSynonyms5 } from "./synonyms_es_5.js";
import { esSynonyms6 } from "./synonyms_es_6.js";
import { deSynonyms1 } from "./synonyms_de_1.js";
import { deSynonyms2 } from "./synonyms_de_2.js";
import { deSynonyms3 } from "./synonyms_de_3.js";
import { deSynonyms4 } from "./synonyms_de_4.js";
import { deSynonyms5 } from "./synonyms_de_5.js";
import { deSynonyms6 } from "./synonyms_de_6.js";

const run = async () => {
  const db = await connectDatabase();

  const esSynonymsList = [
    ...Object.values(esSynonyms1),
    ...Object.values(esSynonyms2),
    ...Object.values(esSynonyms3),
    ...Object.values(esSynonyms4),
    ...Object.values(esSynonyms5),
    ...Object.values(esSynonyms6),
  ];

  const deSynonymsList = [
    ...Object.values(deSynonyms1),
    ...Object.values(deSynonyms2),
    ...Object.values(deSynonyms3),
    ...Object.values(deSynonyms4),
    ...Object.values(deSynonyms5),
    ...Object.values(deSynonyms6),
  ];

  const phrasesData = JSON.parse(
    fs.readFileSync("_seed/phrases_for_synonyms.json", "utf-8"),
  );
  const { esPhrases, dePhrases } = phrasesData;

  console.log(
    `Loaded ${esSynonymsList.length} ES synonyms and ${deSynonymsList.length} DE synonyms.`,
  );
  console.log(
    `Loaded ${esPhrases.length} ES phrases and ${dePhrases.length} DE phrases from JSON.`,
  );

  if (
    esPhrases.length !== esSynonymsList.length ||
    dePhrases.length !== deSynonymsList.length
  ) {
    console.error("Mismatch in lengths! Aborting.");
    process.exit(1);
  }

  let esUpdated = 0;
  for (let i = 0; i < esPhrases.length; i++) {
    const phraseId = esPhrases[i]._id;
    const synonyms = esSynonymsList[i];
    await db.phrasesES.updateOne(
      { _id: new ObjectId(phraseId) },
      { $set: { synonyms } },
    );
    esUpdated++;
  }
  console.log(`Updated ${esUpdated} ES phrases with synonyms.`);

  let deUpdated = 0;
  for (let i = 0; i < dePhrases.length; i++) {
    const phraseId = dePhrases[i]._id;
    const synonyms = deSynonymsList[i];
    await db.phrasesDE.updateOne(
      { _id: new ObjectId(phraseId) },
      { $set: { synonyms } },
    );
    deUpdated++;
  }
  console.log(`Updated ${deUpdated} DE phrases with synonyms.`);

  console.log("Synonyms enrichment complete.");
  process.exit(0);
};

run().catch(console.error);
