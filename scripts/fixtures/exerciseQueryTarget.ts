import assert from "node:assert/strict";

const fixtureName = /^exercise_query_performance_tests_\d+_[a-f0-9]{12}$/;

/** Validate before importing application connection code or touching a database. */
export function exerciseQueryTarget(uri: string, databaseName: string) {
  assert.ok(fixtureName.test(databaseName), "Use a unique exercise-query fixture database");
  assert.ok(uri === uri.trim(), "Unsafe exercise-query target");
  let target: URL;
  try { target = new URL(uri); } catch { throw new Error("Unsafe exercise-query target"); }
  assert.ok(target.protocol === "mongodb:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Exercise-query tests require loopback MongoDB");
  assert.ok(!target.username && !target.password && !target.hash, "Exercise-query tests reject credentials and fragments");
  assert.ok(!target.pathname || target.pathname === "/" || fixtureName.test(target.pathname.slice(1)), "Exercise-query tests reject nonfixture databases");
  for (const [key, value] of target.searchParams) {
    assert.ok(key === "directConnection" && value === "true", "Exercise-query tests require directConnection and reject other connection options");
  }
  target.pathname = `/${databaseName}`;
  target.searchParams.set("directConnection", "true");
  return target.toString();
}
