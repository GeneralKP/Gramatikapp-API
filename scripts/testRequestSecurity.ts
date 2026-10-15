import assert from "node:assert/strict";
import { WindowBudget, addressBucket } from "../src/lib/requestSecurity.js";

const budget = new WindowBudget(2, 1000, 2);
assert.equal(budget.consume("first", 0), 0);
assert.equal(budget.consume("first", 1), 0);
assert.equal(budget.consume("first", 999), 1);
assert.equal(budget.consume("second", 999), 0);
assert.equal(budget.consume("third", 999), 1, "new identities cannot evict still-limited visitors or grow the counter store");
assert.equal(budget.consume("first", 1000), 0, "visitors recover at the window boundary");
assert.equal(budget.consume("third", 2000), 0, "expired visitors free storage for new identities");
assert.equal(addressBucket("::ffff:192.0.2.1"), addressBucket("192.0.2.1"));
assert.equal(addressBucket("0:0:0:0:0:ffff:c000:201"), addressBucket("192.0.2.1"));
assert.equal(addressBucket("0:0:0:0:0:ffff:192.0.2.1"), addressBucket("192.0.2.1"));
assert.equal(addressBucket("2001:db8:1234:5678::1"), addressBucket("2001:0db8:1234:5678:ffff:ffff:ffff:ffff"), "rotating IPv6 host suffixes cannot reset a budget");
assert.notEqual(addressBucket("2001:db8:1234:5678::1"), addressBucket("2001:db8:1234:5679::1"));
console.log("PASS bounded counter storage, window recovery, equivalent IP spellings and IPv6 subnet limits");
