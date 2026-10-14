import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';

/** Model only the Mongo boundary for the no-network consumer suites. These
 * deterministic fixture fingerprints deliberately do not emulate Mongo hashes
 * or normalization: testCatalogSignatures verifies the real Mongo expressions. */
export function fixtureCatalogAggregate(projectedRows: any[], pipeline: any[]) {
  assert.ok(pipeline[0].$match && pipeline[1].$project && pipeline[2].$replaceWith, 'catalog fixture requires the projected/hash source pipeline');
  const wrapped = projectedRows.map(row => {
    const digest = createHash('sha256').update(BSON.EJSON.stringify(row, { relaxed: false })).digest('hex');
    return { row, hashA: String(BigInt(`0x${digest.slice(0, 16)}`)), hashB: String(BigInt(`0x${digest.slice(16, 32)}`)) };
  });
  if (!pipeline.some(stage => stage.$group)) return wrapped;
  if (!wrapped.length) return [];
  return [{ count: String(wrapped.length), checksumA: String(wrapped.reduce((sum, row) => sum + BigInt(row.hashA), 0n)), checksumB: String(wrapped.reduce((sum, row) => sum + BigInt(row.hashB), 0n)) }];
}
