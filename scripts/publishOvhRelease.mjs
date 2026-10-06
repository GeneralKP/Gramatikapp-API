import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const repository = "GeneralKP/Gramatikapp-API";
const branch = "ovh-production-releases";
const sha = process.env.GITHUB_SHA;
const runId = Number(process.env.GITHUB_RUN_ID);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_EVENT_NAME !== "push" || !/^[0-9a-f]{40}$/.test(sha || "") || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1 || !process.env.GH_TOKEN) {
  throw new Error("Publish only from this repository's main push workflow");
}
const request = async (path, method = "GET", body) => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "gramatik-ci" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
  return response.json();
};
const latest = () => request("/git/ref/heads/main").then(ref => ref.object.sha);
if (await latest() !== sha) {
  console.log("A newer main commit exists; release publication skipped.");
  process.exit(0);
}
const archive = await readFile("release.tar.gz");
if (archive.length > 32 * 1024 * 1024) throw new Error("Release archive exceeds 32 MiB");
const manifest = { version: 1, repository, sourceCommit: sha, runId, runAttempt, archiveSha256: createHash("sha256").update(archive).digest("hex") };
const files = { "manifest.json": Buffer.from(JSON.stringify(manifest) + "\n"), "release.tar.gz": archive };
const tree = [];
for (const [path, data] of Object.entries(files)) {
  const blob = await request("/git/blobs", "POST", { content: data.toString("base64"), encoding: "base64" });
  tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
}
const createdTree = await request("/git/trees", "POST", { tree });
const commit = await request("/git/commits", "POST", { message: `Tested OVH release ${sha}`, tree: createdTree.sha, parents: [] });
if (await latest() !== sha) {
  console.log("Main changed during packaging; publication skipped.");
  process.exit(0);
}
const existing = await fetch(`https://api.github.com/repos/${repository}/git/ref/heads/${branch}`, {
  headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000),
});
if (existing.status === 404) await request("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
else {
  if (!existing.ok) throw new Error(`Cannot check release branch: ${existing.status}`);
  await request(`/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: true });
}
console.log(`Published tested release ${sha}; waiting for OVH readiness.`);
const deadline = Date.now() + 360000;
let reportedNativeProbeFailure = false;
let reportedProbeFailure = false;
while (Date.now() < deadline) {
  if (await latest() !== sha) {
    console.log("Superseded by a newer main commit; it will receive its own deployment.");
    process.exit(0);
  }
  try {
    let health;
    try {
      const response = await fetch("https://vps-0f140ad8.vps.ovh.net:8443/health", { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      health = await response.json();
    } catch (error) {
      if (!reportedNativeProbeFailure) {
        console.warn(`Native public health probe failed: ${error.message} (${error.cause?.code || error.name}); trying certificate-verified IPv4 HTTPS.`);
        reportedNativeProbeFailure = true;
      }
      // The VPS has an IPv4 production listener. Use the runner's system TLS
      // client if Node's DNS/network/TLS stack cannot reach that listener.
      health = JSON.parse(execFileSync("curl", ["--ipv4", "--fail", "--silent", "--show-error", "--connect-timeout", "3", "--max-time", "5", "--header", "Cache-Control: no-cache", "https://vps-0f140ad8.vps.ovh.net:8443/health"], { encoding: "utf8", timeout: 7000, stdio: ["ignore", "pipe", "pipe"] }));
    }
    if (health.status === "ok" && health.release === sha) {
      console.log(`OVH is healthy and running ${sha}.`);
      process.exit(0);
    }
  } catch (error) {
    if (!reportedProbeFailure) {
      console.warn(`Public readiness is not confirmed yet: ${error.message}`);
      reportedProbeFailure = true;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
}
throw new Error("OVH did not serve the expected healthy commit within six minutes; inspect gramatik-deploy on the VPS");
