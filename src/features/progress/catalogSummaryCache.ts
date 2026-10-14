import { ObjectId } from "mongodb";
import { getDb, type Database } from "../../lib/database.js";

// Catalog summaries contain no user/progress data. External catalog imports are
// validated within this short TTL; in-process catalog writes invalidate at once.
export const CATALOG_SUMMARY_TTL_MS = 30_000;
export type CatalogPart = "words" | "phrases" | "wordMeta" | "phraseMeta" | "wordTextDe" | "phraseTextDe" | "grammarSurfaceDe";
export interface CatalogSnapshot<T> { rows: T[]; signature: string }
export interface CatalogSource<T> {
  loadSnapshot(): Promise<CatalogSnapshot<T>>;
  readSignature(): Promise<string>;
}
type Loader<T> = CatalogSource<T> | (() => Promise<T[]>);
type Entry = { expiresAt: number; promise: Promise<unknown[]>; signature?: string; refresh?: Promise<unknown[]> };

// Pure-loader support keeps small deterministic fixtures independent of Mongo.
// Every production catalog consumer supplies the signature-bearing source.
function isSource<T>(load: Loader<T>): load is CatalogSource<T> { return typeof (load as CatalogSource<T>).loadSnapshot === "function"; }
async function snapshot<T>(load: Loader<T>): Promise<{ rows: T[]; signature?: string }> {
  return isSource(load) ? load.loadSnapshot() : { rows: await load(), signature: undefined };
}

function immutableCopy(value: any): any {
  if (!value || typeof value !== "object" || value instanceof ObjectId) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)])));
}

export function createCatalogSummaryCache(clock: () => number = Date.now) {
  const databases = new WeakMap<Database, Map<CatalogPart, Entry>>();
  return {
    read<T>(db: Database, part: CatalogPart, load: Loader<T>): Promise<T[]> {
      let parts = databases.get(db);
      if (!parts) databases.set(db, parts = new Map());
      let entry = parts.get(part);
      // Background refresh never makes a browser wait while the current value
      // remains fresh. After the hard TTL, await the replacement rather than
      // serving stale data or starting a duplicate load.
      if (entry && entry.expiresAt <= clock() && entry.refresh) return entry.refresh as Promise<T[]>;
      if (entry && entry.expiresAt <= clock() && isSource(load)) return this.refresh(db, part, load);
      if (!entry || entry.expiresAt <= clock()) {
        entry = { expiresAt: Infinity, promise: undefined! };
        const current = entry;
        // Singleflight includes in-flight loads, and rejected loads are retried.
        current.promise = Promise.resolve().then(() => snapshot(load)).then(({ rows, signature }) => {
          current.expiresAt = clock() + CATALOG_SUMMARY_TTL_MS;
          current.signature = signature;
          return immutableCopy(rows);
        }).catch(error => {
          if (parts!.get(part) === current) parts!.delete(part);
          throw error;
        });
        parts.set(part, current);
      }
      return entry.promise as Promise<T[]>;
    },
    refresh<T>(db: Database, part: CatalogPart, load: Loader<T>): Promise<T[]> {
      const parts = databases.get(db), current = parts?.get(part);
      if (!current || current.expiresAt === Infinity) return this.read(db, part, load);
      if (!current.refresh) {
        current.refresh = Promise.resolve().then(async () => {
          if (isSource(load) && await load.readSignature() === current.signature) {
            if (databases.get(db) === parts && parts!.get(part) === current) current.expiresAt = clock() + CATALOG_SUMMARY_TTL_MS;
            return current.promise;
          }
          const { rows, signature } = await snapshot(load);
          const immutable = immutableCopy(rows);
          // Catalog writes or a newer read may have replaced this generation.
          // An older background load must never put that snapshot back.
          if (databases.get(db) === parts && parts!.get(part) === current) {
            parts!.set(part, { expiresAt: clock() + CATALOG_SUMMARY_TTL_MS, promise: Promise.resolve(immutable), signature });
          }
          return immutable;
        }).finally(() => { delete current.refresh; });
      }
      return current.refresh as Promise<T[]>;
    },
    invalidate(db: Database, part?: CatalogPart) {
      if (part) databases.get(db)?.delete(part);
      else databases.delete(db);
    },
  };
}

export const catalogSummaryCache = createCatalogSummaryCache();
export function invalidateStudyCatalog(db: Database = getDb(), part?: CatalogPart) { catalogSummaryCache.invalidate(db, part); }
