import { connectDatabase } from "../src/lib/database";

async function check() {
  const db = await connectDatabase();

  const totalES = await db.phrasesES.countDocuments();
  const withoutES = await db.phrasesES.countDocuments({
    $or: [
      { synonyms: { $exists: false } },
      { synonyms: { $size: 0 } },
      { synonyms: null },
    ],
  });

  const totalDE = await db.phrasesDE.countDocuments();
  const withoutDE = await db.phrasesDE.countDocuments({
    $or: [
      { synonyms: { $exists: false } },
      { synonyms: { $size: 0 } },
      { synonyms: null },
    ],
  });

  console.log(`PHRASES_ES: Total ${totalES}, Without Synonyms ${withoutES}`);
  console.log(`PHRASES_DE: Total ${totalDE}, Without Synonyms ${withoutDE}`);

  process.exit(0);
}

check().catch((err) => {
  console.error(err);
  process.exit(1);
});
