import type { RequestHandler } from "express";
import { isIP } from "node:net";

/** Fixed windows with a hard identity cap. A full store fails closed until expiry. */
export class WindowBudget {
  private readonly buckets = new Map<string, { count: number; expires: number }>();
  private nextSweep = 0;

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  /** Zero admits the request; a positive result is the retry delay in seconds. */
  consume(key: string, now = Date.now()): number {
    if (now >= this.nextSweep) {
      for (const [identity, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(identity);
      this.nextSweep = now + this.windowMs;
    }
    let bucket = this.buckets.get(key);
    if (bucket && bucket.expires <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return Math.ceil(this.windowMs / 1000);
      bucket = { count: 0, expires: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) return Math.max(1, Math.ceil((bucket.expires - now) / 1000));
    bucket.count++;
    return 0;
  }
}

/** Group IPv6 privacy addresses by /64 and normalize IPv4-mapped IPv6. */
export function addressBucket(address: string): string {
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) !== 6) return isIP(address) === 4 ? address : "unknown";
  const [left, right] = address.toLowerCase().split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill("0"), ...after];
  const values = groups.map(group => Number.parseInt(group, 16));
  if (values.slice(0, 5).every(value => value === 0) && values[5] === 0xffff) {
    const dotted = groups.at(-1)!;
    if (isIP(dotted) === 4) return dotted;
    return `${values[6] >> 8}.${values[6] & 255}.${values[7] >> 8}.${values[7] & 255}`;
  }
  return values.slice(0, 4).map(value => value.toString(16)).join(":") + "::/64";
}

export function requestAdmission(): RequestHandler {
  const visitors = new WindowBudget(600, 60_000);
  const processBudget = new WindowBudget(1200, 60_000, 1);
  let active = 0;
  return (req, res, next) => {
    if (req.method === "OPTIONS" || (req.method === "GET" && req.path === "/health")) { next(); return; }
    const address = isIP(req.ip ?? "") ? req.ip! : req.socket.remoteAddress ?? "unknown";
    const retryAfter = visitors.consume(addressBucket(address)) || processBudget.consume("all");
    if (retryAfter || active >= 64) {
      res.set("Retry-After", String(retryAfter || 1)).set("Cache-Control", "no-store").status(429).json({
        error: "Too many requests. Please wait and try again.",
        errors: [{ message: "Too many requests. Please wait and try again.", extensions: { code: "TOO_MANY_REQUESTS" } }],
      });
      return;
    }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}
