import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { GraphQLError } from "graphql";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { getUserFromToken, hashPassword, loginWithEmail, registerWithEmail, verifyPassword, verifyToken } from "../src/features/auth/auth.service.js";

let databaseWork = 0;
const users: any[] = [];
const collection = (name: string) => ({
  async createIndex() {},
  async dropIndex() {},
  async findOne(filter: any, options: any = {}) {
    databaseWork++;
    const user = name === "users" ? users.find(user => (!filter.email || user.email === filter.email) && (!filter._id || String(user._id) === String(filter._id))) : null;
    return user && options.projection ? Object.fromEntries(Object.keys(options.projection).filter(key => options.projection[key] && key in user).map(key => [key, user[key]])) : user ?? null;
  },
  async insertOne(user: any) { databaseWork++; users.push(user); return { acknowledged: true, insertedId: user._id }; },
});
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as any; };
await connectDatabase();

try {
  // Service inputs are a supported boundary too: reject malformed credentials
  // before account lookups or password work, independently of GraphQL coercion.
  for (const [email, password, message] of [
    ["person@example.invalid", "short", "Password must be at least 6 characters"],
    ["missing-at", "fixture-password", "Enter a valid email address."],
    ["x".repeat(321), "fixture-password", "Enter a valid email address."],
    [null, "fixture-password", "Enter a valid email address."],
    ["person@example.invalid", null, "Password must be at least 6 characters"],
  ] as const) {
    databaseWork = 0;
    await assert.rejects(registerWithEmail(email as any, password as any), error => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, message);
      assert.equal(error.extensions.code, "BAD_USER_INPUT");
      return true;
    });
    assert.equal(databaseWork, 0, "Invalid registration must not query or write accounts");
  }
  for (const [email, password] of [["", "valid-password"], [null, "valid-password"], ["x".repeat(321), "valid-password"], ["legacy-name", ""], ["legacy-name", null]]) {
    databaseWork = 0;
    await assert.rejects(loginWithEmail(email as any, password as any), error => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, "Invalid email or password");
      assert.equal(error.extensions.code, "BAD_USER_INPUT");
      return true;
    });
    assert.equal(databaseWork, 0, "Malformed login must not query accounts");
  }
  console.log("PASS malformed credentials rejected before database access");

  const assertBusy = (error: unknown) => {
    assert.ok(error instanceof GraphQLError);
    assert.equal(error.extensions.code, "TOO_MANY_REQUESTS");
    const http = error.extensions.http as { status: number; headers: Map<string, string> };
    assert.equal(http.status, 429);
    assert.equal(http.headers.get("retry-after"), "1");
    return true;
  };
  const first = hashPassword("fixture-password"), second = hashPassword("another-fixture");
  await assert.rejects(verifyPassword("wrong", "unused-when-busy"), assertBusy);
  const [firstHash] = await Promise.all([first, second]);
  const comparisons = [verifyPassword("fixture-password", firstHash), verifyPassword("wrong", firstHash)];
  await assert.rejects(hashPassword("third-fixture"), assertBusy);
  assert.deepEqual(await Promise.all(comparisons), [true, false]);
  const failed = await Promise.allSettled([hashPassword(undefined as any), hashPassword(null as any)]);
  assert.ok(failed.every(result => result.status === "rejected"));
  assert.equal(await verifyPassword("fixture-password", firstHash), true, "Failed password operations must release capacity");
  const asynchronousFailure = await Promise.allSettled([verifyPassword("fixture-password", undefined as any), verifyPassword("fixture-password", firstHash)]);
  assert.equal(asynchronousFailure[0].status, "rejected");
  assert.deepEqual(asynchronousFailure[1], { status: "fulfilled", value: true });
  assert.equal(await verifyPassword("fixture-password", firstHash), true, "Asynchronous bcrypt rejection must also release capacity");
  console.log("PASS two concurrent real password operations, immediate busy rejection, success/failure capacity recovery");

  // Literals captured with the previous full-input bcrypt implementation and a
  // fixed cost-4 fixture salt. They include a UTF-16 pair crossing byte 72.
  const passwords = [
    ["long ASCII", "a".repeat(8192), "$2b$04$K5nPwyt2z1G9L32zM1o3EeRnYJ5M/cl/6CfRM.Rf1nPa9U7fIewbC"],
    ["long Unicode", "ä".repeat(4096), "$2b$04$K5nPwyt2z1G9L32zM1o3Ee0Vc6GgWpickprldV5OeDe7G.G0JmsPS"],
    ["surrogate boundary", "a".repeat(71) + "😀" + "z".repeat(8192), "$2b$04$K5nPwyt2z1G9L32zM1o3Ee8HFwmP2FAwxGYBd/mhW4fpd/92IBV8a"],
    ["lone surrogate", "a".repeat(71) + "\ud800" + "z".repeat(8192), "$2b$04$K5nPwyt2z1G9L32zM1o3EeKq2C7Rn.R.U2mJYJbw3H7ASL8R/vDLe"],
    ["exactly 72 bytes", "b".repeat(72), "$2b$04$K5nPwyt2z1G9L32zM1o3EexM4bHSVbJFcPMcuwxu6gmBsACcHaRqi"],
    ["significant whitespace", "  space password \n", "$2b$04$K5nPwyt2z1G9L32zM1o3EeKwmWzl8q2kGx8NYxKUwoYFcNqMceyVe"],
    ["decomposed Unicode", "cafe\u0301" + "x".repeat(300), "$2b$04$K5nPwyt2z1G9L32zM1o3Ee/v5NhkT7HbUvV6DmizgF384rB5b6Ape"],
    ["embedded null", "with\u0000null" + "x".repeat(300), "$2b$04$K5nPwyt2z1G9L32zM1o3EevN7oNxO0Q0FU7AhJgPELvEDqmpuQoJi"],
  ];
  const originalHash = bcrypt.hash, originalCompare = bcrypt.compare;
  let boundedCalls = 0;
  // Observe the third-party crypto boundary, while using the real library.
  bcrypt.hash = ((password: string, salt: number) => {
    assert.ok(password.length <= 73, "Hash encoding must receive a bounded password prefix");
    boundedCalls++;
    return originalHash(password, salt);
  }) as typeof bcrypt.hash;
  bcrypt.compare = ((password: string, hash: string) => {
    assert.ok(password.length <= 73, "Comparison encoding must receive a bounded password prefix");
    boundedCalls++;
    return originalCompare(password, hash);
  }) as typeof bcrypt.compare;
  try {
    for (const [name, password, legacyHash] of passwords) {
      assert.equal(await verifyPassword(password, legacyHash), true, name);
      const newHash = await hashPassword(password);
      assert.equal(bcrypt.getRounds(newHash), 10);
      assert.equal(await originalCompare(password, newHash), true, `${name}: old verification accepts new hash`);
    }
  } finally { bcrypt.hash = originalHash; bcrypt.compare = originalCompare; }
  assert.equal(boundedCalls, 16);
  console.log("PASS bounded encoding preserves fixed legacy hashes and new hash compatibility for long/Unicode passwords");

  const oversizedSignedToken = jwt.sign({ userId: String(new ObjectId()), email: "fixture@example.invalid", padding: "x".repeat(8192) }, process.env.JWT_SECRET || "dev-secret-change-in-production");
  assert.ok(oversizedSignedToken.length > 8192);
  const originalVerify = jwt.verify;
  let jwtWork = 0;
  jwt.verify = ((...args: Parameters<typeof jwt.verify>) => { jwtWork++; return (originalVerify as any)(...args); }) as typeof jwt.verify;
  try {
    for (const token of [oversizedSignedToken, "x".repeat(8193), "ä".repeat(4097)]) {
      databaseWork = 0; jwtWork = 0;
      assert.equal(verifyToken(token), null);
      assert.equal(await getUserFromToken(token), null);
      assert.equal(jwtWork, 0, "Oversized JWT must fail before signature verification");
      assert.equal(databaseWork, 0, "Oversized JWT must not query accounts");
    }
  } finally { jwt.verify = originalVerify; }
  console.log("PASS oversized bearer tokens rejected before signature verification and database access");

  const registered = await registerWithEmail("Person+Tag@Example.Invalid", "  pass😀word  ");
  assert.equal(registered.user.email, "person+tag@example.invalid");
  assert.equal(registered.user.authProvider, "email");
  assert.equal(await verifyPassword("  pass😀word  ", registered.user.passwordHash!), true);
  assert.equal(await verifyPassword("pass😀word", registered.user.passwordHash!), false, "Password whitespace remains significant");
  const signedIn = await loginWithEmail("PERSON+TAG@EXAMPLE.INVALID", "  pass😀word  ");
  assert.equal(String(signedIn.user._id), String(registered.user._id));
  const authenticated = await getUserFromToken(signedIn.token);
  assert.equal(String(authenticated?._id), String(registered.user._id));
  assert.equal(authenticated?.passwordHash, undefined, "Authenticated account reads omit password hashes");
  const legacy = { ...registered.user, _id: new ObjectId(), email: " legacy identifier ", passwordHash: passwords[2][2] };
  users.push(legacy);
  const legacyLogin = await loginWithEmail(" LEGACY IDENTIFIER ", passwords[2][1]);
  assert.equal(String(legacyLogin.user._id), String(legacy._id), "Login keeps legacy address formatting and very long Unicode passwords");
  await assert.rejects(loginWithEmail("missing@example.invalid", "fixture-password"), /^Error: Invalid email or password$/);
  await assert.rejects(loginWithEmail(registered.user.email, "incorrect"), /^Error: Invalid email or password$/);
  await assert.rejects(registerWithEmail(registered.user.email.toUpperCase(), "fixture-password"), /^Error: User with this email already exists$/);
  users.push({ ...registered.user, _id: new ObjectId(), email: "provider@example.invalid", authProvider: "google" });
  await assert.rejects(loginWithEmail("provider@example.invalid", "fixture-password"), /^Error: Please sign in with google$/);
  console.log("PASS registration/login payloads, case matching, legacy formats, hash projection and existing error messages");
} finally { await closeDatabase(); }
