import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, MongoClient, type ClientSession, type Db, type Document } from "mongodb";
import { WORD_CARD_COLLECTIONS, wordCardSHA256, type WordCardCollection } from "./lib/wordCardMigration.js";

export interface WordCardSnapshot {
  auditedAt: string;
  database: string;
  targetSHA256?: string;
  startedAt?: string;
  readConsistency?: string;
  collections: Record<WordCardCollection, Document[]>;
}
export function wordCardSnapshotConnection(environment: Record<string, string | undefined>, databaseOverride?: string) {
  let uri = environment.MONGODB_URI;
  if (!uri) {
    const { DB_USER, DB_USER_PASSWORD, DB_CLUSTER } = environment;
    if (!DB_USER || !DB_USER_PASSWORD || !DB_CLUSTER || !/^[a-z\d.-]+$/iu.test(DB_CLUSTER)) throw new Error("snapshot_configuration_invalid");
    uri = `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_USER_PASSWORD)}@${DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
  }
  const database = databaseOverride || environment.DB_NAME || "gramatikapp";
  if (!/^mongodb(?:\+srv)?:\/\//u.test(uri) || !/^[A-Za-z\d_-]+$/u.test(database)) throw new Error("snapshot_configuration_invalid");
  const server = uri.replace(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+).*$/u, "$1").toLowerCase();
  return { uri, database, targetSHA256: wordCardSHA256(`${server}/${database}`) };
}

/** Raw finds only. A caller-supplied snapshot session binds the four reads. */
export async function captureWordCardSnapshot(db: Pick<Db, "collection">, database: string, options: { session?: ClientSession; targetSHA256?: string; clock?: () => Date } = {}): Promise<WordCardSnapshot> {
  const clock = options.clock || (() => new Date()), startedAt = clock().toISOString();
  const collections = {} as WordCardSnapshot["collections"];
  // Snapshot-session reads are sequential so the first read establishes atClusterTime.
  for (const name of WORD_CARD_COLLECTIONS) collections[name] = await db.collection(name).find(name === "userprogresses" ? { itemType: "WORD" } : {}, { ...(options.session ? { session: options.session } : {}) }).sort({ _id: 1 }).toArray();
  return { auditedAt: clock().toISOString(), startedAt, database, ...(options.targetSHA256 ? { targetSHA256: options.targetSHA256 } : {}), readConsistency: options.session ? "MongoDB snapshot session" : "Caller-supplied offline fixture; consistency not asserted", collections };
}

/** Both files are exclusive; an existing audit is never overwritten. */
export async function writeWordCardSnapshotFiles(snapshot: WordCardSnapshot, snapshotPath: string, summaryPath = `${snapshotPath}.summary.json`) {
  if (resolve(snapshotPath) === resolve(summaryPath)) throw new Error("snapshot_output_paths_overlap");
  const serialized = BSON.EJSON.stringify(snapshot, { relaxed: false });
  const summary = { version: 1, auditedAt: snapshot.auditedAt, startedAt: snapshot.startedAt, database: snapshot.database, targetSHA256: snapshot.targetSHA256, readConsistency: snapshot.readConsistency, snapshotSHA256: wordCardSHA256(serialized), bytes: Buffer.byteLength(serialized), counts: Object.fromEntries(WORD_CARD_COLLECTIONS.map(name => [name, snapshot.collections[name].length])), notice: "Read-only raw MongoDB snapshot. No application startup, indexes, writes, provider calls or archived collection reads." };
  for (const directory of new Set([dirname(snapshotPath), dirname(summaryPath)])) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
  let snapshotHandle: Awaited<ReturnType<typeof open>> | undefined, summaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let createdSnapshot = false, createdSummary = false, success = false;
  try {
    snapshotHandle = await open(snapshotPath, "wx", 0o600); createdSnapshot = true;
    summaryHandle = await open(summaryPath, "wx", 0o600); createdSummary = true;
    await snapshotHandle.chmod(0o600); await summaryHandle.chmod(0o600);
    await snapshotHandle.writeFile(serialized); await snapshotHandle.sync();
    await summaryHandle.writeFile(JSON.stringify(summary, null, 2) + "\n"); await summaryHandle.sync();
    success = true; return summary;
  } finally {
    await snapshotHandle?.close(); await summaryHandle?.close();
    if (!success) { if (createdSnapshot) await unlink(snapshotPath).catch(() => undefined); if (createdSummary) await unlink(summaryPath).catch(() => undefined); }
  }
}

async function main() {
  const values = new Map<string, string>(), args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log("Read-only snapshot: --output private.ejson [--summary private.json] [--database name] [--env-file path]"); return; }
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--output", "--summary", "--database", "--env-file"].includes(key) || values.has(key) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("snapshot_arguments_invalid");
    values.set(key, args[++index]);
  }
  if (!values.has("--output")) throw new Error("snapshot_output_required");
  const snapshotPath = resolve(values.get("--output")!), summaryPath = values.has("--summary") ? resolve(values.get("--summary")!) : `${snapshotPath}.summary.json`;
  if (snapshotPath === summaryPath) throw new Error("snapshot_output_paths_overlap");
  for (const path of [snapshotPath, summaryPath]) {
    try { await lstat(path); throw new Error("snapshot_output_already_exists"); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  const { config } = await import("dotenv");
  config({ path: values.has("--env-file") ? resolve(values.get("--env-file")!) : ".env", override: false, debug: false });
  const connection = wordCardSnapshotConnection(process.env, values.get("--database"));
  const client = new MongoClient(connection.uri, { serverSelectionTimeoutMS: 10000, readPreference: "primary" });
  let session: ClientSession | undefined;
  try {
    await client.connect(); session = client.startSession({ snapshot: true });
    const snapshot = await captureWordCardSnapshot(client.db(connection.database), connection.database, { session, targetSHA256: connection.targetSHA256 });
    const summary = await writeWordCardSnapshotFiles(snapshot, snapshotPath, summaryPath);
    console.log(JSON.stringify({ status: "snapshot_saved", auditedAt: summary.auditedAt, snapshotSHA256: summary.snapshotSHA256, bytes: summary.bytes, counts: summary.counts }));
  } finally { await session?.endSession().catch(() => undefined); await client.close().catch(() => undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error(JSON.stringify({ status: "snapshot_failed", reason: "Check configuration, snapshot-session support and exclusive private output paths; raw errors and connection details are suppressed" })); process.exitCode = 1; });
