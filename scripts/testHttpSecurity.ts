import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../src/app.js";

// Exercise the HTTP application without the startup path opening a real database.
const { httpServer, server } = await createApplication();
httpServer.listen(0, "127.0.0.1");
await once(httpServer, "listening");
const port = (httpServer.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/graphql`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
try {
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal(health.headers.get("cache-control"), "no-store");
  const me = await post({ query: "{ me { id } }" });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { data: { me: null } });
  const own = await post({ query: 'query { user(id:"000000000000000000000001") { id } }' });
  assert.equal((await own.json()).errors[0].message, "Unauthorized");
  const sync = await fetch(`${origin}/api/study/sync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"operations":[]}',
  });
  assert.equal(sync.status, 401);
  assert.deepEqual(await sync.json(), { error: "Unauthorized" });
  console.log("PASS HTTP health, anonymous me, ownership rejection and REST sync rejection without database startup");
  const aliased = await post({ query: 'mutation { a:login(email:"person@example.test",password:"wrong"){token} b:login(email:"person@example.test",password:"wrong"){token} }' });
  const rejected = await aliased.json();
  assert.equal(rejected.errors?.[0].extensions?.code, "BAD_USER_INPUT", "multiple auth fields must be rejected before any credential/database work");
  assert.match(rejected.errors[0].message, /one authentication/i);
  console.log("PASS authentication aliases cannot multiply password work in one request");
  const fragmentAliases = await post({ query: 'mutation { ...A ... on Mutation { b:register(email:"person@example.test",password:"123456"){token} } } fragment A on Mutation { a:login(email:"person@example.test",password:"wrong"){token} }' });
  assert.match((await fragmentAliases.json()).errors[0].message, /one authentication/i);
  const login = { query: 'mutation { login(email:"",password:""){token} }' };
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await post(login, { "X-Forwarded-For": `198.51.100.${attempt}, 203.0.113.10` });
    assert.notEqual(response.status, 429, "a normal first attempt must not be rate limited");
    await response.json();
  }
  const limited = await post(login, { "X-Forwarded-For": "198.51.100.99, 203.0.113.10" });
  assert.equal(limited.status, 429, "spoofing a forwarded prefix cannot reset the authentication budget");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await limited.json()).errors[0].extensions.code, "TOO_MANY_REQUESTS");
  const independent = await post(login, { "X-Forwarded-For": "203.0.113.11" });
  assert.notEqual(independent.status, 429, "one visitor's failed attempts must not lock another visitor out");
  await independent.json();
  console.log("PASS bounded authentication attempts, forwarded-prefix spoof resistance, independent visitors and Retry-After");
  const oversized = await post({ query: `{${Array.from({ length: 41 }, (_, index) => `u${index}:me{id}`).join(" ")}}` });
  assert.equal(oversized.status, 400, "public field aliases must have a bounded operation budget");
  assert.match((await oversized.json()).errors[0].message, /operation.*large/i);
  const tokenFlood = await post({ query: `{${Array.from({ length: 1000 }, (_, index) => `u${index}:me{id}`).join(" ")}}` });
  assert.equal(tokenFlood.status, 400);
  assert.equal((await tokenFlood.json()).errors[0].extensions.code, "GRAPHQL_PARSE_FAILED", "oversized token streams must stop during parsing");
  const sourceFlood = await post({ query: `{me{id}}${" ".repeat(65_536)}` });
  assert.equal(sourceFlood.status, 413, "large GraphQL source must fail before parsing even when it has few tokens");
  await sourceFlood.json();
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await post({ query: 'query { words(lang:"DE",limit:1){id} }' }, { "X-Forwarded-For": "203.0.113.40" });
    assert.notEqual(response.status, 429);
    await response.json();
  }
  const publicLimit = await post({ query: 'query { words(lang:"DE",limit:1){id} }' }, { "X-Forwarded-For": "203.0.113.40" });
  assert.equal(publicLimit.status, 429, "anonymous database readers need a separate budget from cheap unauthenticated requests");
  assert.ok(Number(publicLimit.headers.get("retry-after")) > 0);
  await publicLimit.json();
  const malformed = await fetch(`${origin}/graphql`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"private":"fixture-marker",broken}',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type") ?? "", /application\/json/, "parser failures must be safe JSON responses");
  const malformedBody = await malformed.text();
  assert.ok(!malformedBody.includes("fixture-marker") && !malformedBody.includes("SyntaxError") && !malformedBody.includes("stack"));
  const bodyFlood = await post({ query: "{me{id}}", variables: { padding: "x".repeat(2 * 1024 * 1024) } });
  assert.equal(bodyFlood.status, 413);
  assert.match(bodyFlood.headers.get("content-type") ?? "", /application\/json/);
  await bodyFlood.json();
  const batched = await post([{ query: "{me{id}}" }, { query: "{me{id}}" }]);
  assert.equal(batched.status, 400, "HTTP batching must not bypass operation/request budgets");
  await batched.json();
  const csrf = await fetch(`${origin}/graphql?query=${encodeURIComponent("{me{id}}")}`);
  assert.equal(csrf.status, 400, "simple cross-site GETs must not execute GraphQL");
  await csrf.json();
  for (let attempt = 0; attempt < 600; attempt++) {
    const response = await post({ query: "{me{id}}" }, { "X-Forwarded-For": "203.0.113.61", Authorization: "Bearer invalid-fixture-token" });
    assert.equal(response.status, 200);
    await response.json();
  }
  const ingressLimit = await post({ query: "{me{id}}", variables: { padding: "x".repeat(2 * 1024 * 1024) } }, { "X-Forwarded-For": "203.0.113.61", Authorization: "Bearer another-forged-token" });
  assert.equal(ingressLimit.status, 429, "ingress is bounded before JSON parsing, even with a forged bearer token");
  await ingressLimit.json();
  const stillHealthy = await fetch(`${origin}/health`);
  assert.equal(stillHealthy.status, 200);
  await stillHealthy.json();
  console.log("PASS GraphQL/parser/body budgets, safe JSON errors, CSRF, batching, anonymous catalog and pre-parser ingress limits");
} finally {
  await server.stop();
}
