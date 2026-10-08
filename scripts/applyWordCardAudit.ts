import * as dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { FileWordCardJournal, WordCardMigrationError, readWordCardManifest, runWordCardMigration, wordCardSHA256, type MigrationMode } from "./lib/wordCardMigration.js";

const usage = "Usage: npx tsx scripts/applyWordCardAudit.ts --manifest audit.ejson [--snapshot snapshot.ejson] [--apply | --rollback] [--writers-paused-for-rollback] [--journal private.ejsonl] [--database name] [--env-file path]";

function argumentsFor(argv: string[]) {
  const values: Record<string, string> = {};
  let mode: MigrationMode = "dry-run";
  let writersPausedForRollback = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--apply" || key === "--rollback") {
      if (mode !== "dry-run") throw new WordCardMigrationError("Choose only one of --apply and --rollback");
      mode = key === "--apply" ? "apply" : "rollback";
    } else if (key === "--writers-paused-for-rollback" && !writersPausedForRollback) {
      writersPausedForRollback = true;
    } else if (["--manifest", "--snapshot", "--journal", "--database", "--env-file"].includes(key)) {
      if (values[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new WordCardMigrationError(usage);
      values[key] = argv[++i];
    } else throw new WordCardMigrationError(usage);
  }
  if (!values["--manifest"]) throw new WordCardMigrationError(usage);
  if (writersPausedForRollback && mode !== "rollback") throw new WordCardMigrationError("Writer-pause acknowledgement applies only to rollback");
  return { values, mode, writersPausedForRollback };
}

let client: MongoClient | undefined, journal: FileWordCardJournal | undefined;
try {
  const { values, mode, writersPausedForRollback } = argumentsFor(process.argv.slice(2));
  const manifestPath = resolve(values["--manifest"]), manifest = await readWordCardManifest(manifestPath);
  if (mode === "rollback" && manifest.inserts.length && !writersPausedForRollback) throw new WordCardMigrationError("Rollback deleting inserted records requires all catalog/reference writers to be paused, then --writers-paused-for-rollback; the flag does not pause them");
  if (values["--snapshot"]) {
    let snapshot: Buffer;
    try { snapshot = await readFile(resolve(values["--snapshot"])); }
    catch { throw new WordCardMigrationError("Snapshot file could not be read"); }
    if (wordCardSHA256(snapshot) !== manifest.snapshotSHA256.toLowerCase()) throw new WordCardMigrationError("Snapshot checksum differs from the audited manifest");
  }
  // dotenv never replaces explicitly supplied process environment values.
  dotenv.config({ path: values["--env-file"] ? resolve(values["--env-file"]) : ".env", override: false });
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    const { DB_USER, DB_USER_PASSWORD, DB_CLUSTER } = process.env;
    if (!DB_USER || !DB_USER_PASSWORD || !DB_CLUSTER || !/^[a-z\d.-]+$/i.test(DB_CLUSTER)) throw new WordCardMigrationError("Configure MONGODB_URI or all DB_USER, DB_USER_PASSWORD and DB_CLUSTER values");
    uri = `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_USER_PASSWORD)}@${DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
  }
  const databaseName = values["--database"] || process.env.DB_NAME || "gramatikapp";
  if (!/^[A-Za-z\d_-]+$/.test(databaseName)) throw new WordCardMigrationError("Invalid database name");
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new WordCardMigrationError("Invalid MongoDB connection configuration");
  if (mode !== "dry-run") {
    // Bind recovery to server/database identity without storing credentials or hosts.
    const server = uri.replace(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+).*$/, "$1").toLowerCase();
    journal = await FileWordCardJournal.open(resolve(values["--journal"] || `${manifestPath}.journal.ejsonl`), manifest, wordCardSHA256(`${server}/${databaseName}`));
  }
  // Importing src/lib/database would create/drop app indexes. Use only the raw driver.
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const result = await runWordCardMigration(client.db(databaseName), manifest, { mode, journal, writersPausedForRollback });
  console.log(JSON.stringify(result));
  if (!result.complete) process.exitCode = 2;
} catch (error) {
  // Driver errors may contain connection details or document content; never print them.
  console.error(error instanceof WordCardMigrationError ? error.message : "Word-card migration failed; preserve its private journal and inspect database connectivity/configuration");
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined);
  await journal?.close().catch(() => { console.error("Could not close the private journal; inspect its lock before retrying"); process.exitCode = 1; });
}
