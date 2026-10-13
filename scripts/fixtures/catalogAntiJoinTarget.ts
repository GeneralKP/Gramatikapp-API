import assert from "node:assert/strict";

const fixtureName = /^catalog_anti_join_tests_\d+_[a-f0-9]{12}$/;

/** Guard before application configuration, connection, writes or cleanup. */
export function catalogAntiJoinTarget(uri: string, name: string) {
  assert.match(name, fixtureName, "Use a unique catalog anti-join fixture database");
  assert.ok(uri === uri.trim(), "Reject target whitespace");
  let target: URL;
  try { target = new URL(uri); } catch { throw new Error("Invalid catalog anti-join fixture target"); }
  assert.equal(target.protocol, "mongodb:");
  assert.equal(target.hostname, "127.0.0.1", "Use the owned numeric loopback fixture");
  assert.ok(["27017", "27028"].includes(target.port), "Use a known MongoDB fixture port");
  assert.ok(!target.username && !target.password && !target.hash, "Reject credentials and fragments");
  assert.ok(target.pathname === "" || target.pathname === "/" || fixtureName.test(target.pathname.slice(1)), "Reject nonfixture databases");
  for (const [key, value] of target.searchParams) {
    assert.ok(key === "directConnection" && value === "true", "Only directConnection=true is allowed");
  }
  target.pathname = `/${name}`;
  target.searchParams.set("directConnection", "true");
  return target.toString();
}
