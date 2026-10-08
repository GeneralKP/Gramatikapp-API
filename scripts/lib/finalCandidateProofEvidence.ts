/** Actual local execution evidence for input-stable final candidate proof composition. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const bindingKeys = ["catalogReviewSHA256", "additionReviewSHA256", "candidateMapSHA256", "provenanceSHA256"] as const;
const metadataKeys = ["version", "helperVersion", "mode", "model", "sourceHash", "scopeHash", "promptHash", "bindings", "totalScope", "offset", "selected"];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(`Final candidate composition: ${message}`); };
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{24}$/u.test(value);
const safeHash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/u.test(value);
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const validAuthors = (input: any) => !!input?.authors && [input.authors.draftAgent, input.authors.reviewAgent].every(agent => typeof agent === "string" && /^\/root\/[a-z\d_]+$/u.test(agent)) && input.authors.draftAgent !== input.authors.reviewAgent;
function keys(value: any, expected: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...expected].sort().join()) fail(`${label} has invalid fields`);
}
// Canonicalize the proof only for the opaque evidence binding; lexical input equality stays byte-exact JSON.stringify.
function canonical(value: any): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return fail("proof must contain only JSON values");
}
function freezeJSON(value: any): any {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeJSON); Object.freeze(value); }
  return value;
}

interface Reference { path: string; SHA256: string }
interface CheckpointReference extends Reference { candidateId: string; job: Reference; result: Reference }
interface Component {
  kind: "historical" | "fresh";
  inputs: Reference;
  proof?: Reference;
  sources: (Reference & { bindingKey: string })[];
  checkpoints: CheckpointReference[];
  selectedCandidateIds: string[];
}
interface Artifact { SHA256: string; value: any }
interface LoadedComponent {
  descriptor: Component;
  inputs: Artifact;
  proof?: Artifact;
  sources: Map<string, Artifact>;
  checkpoints: { reference: CheckpointReference; checkpoint: Artifact; job: Artifact; result: Artifact }[];
}
declare const evidenceBrand: unique symbol;
export interface FinalCandidateProofEvidence { readonly [evidenceBrand]: true }
const evidenceStates = new WeakMap<object, { proofHash: string; components: LoadedComponent[] }>();

export interface FinalCandidateProofEvidencePolicy {
  helperVersion: string;
  model: string;
  promptHash: string;
  instructions: string;
  schema: any;
  validateDecisions(value: any, inputs: any[]): unknown;
  /** Validate an ordinary proof without recursively entering the composition evidence branch. */
  validateOrdinaryProof(proof: any, inputs: any[], bindings: Record<string, string>): unknown;
}

/** Reads only regular, checksum-bound artifacts inside the supplied private audit root. */
export async function loadFinalCandidateProofEvidence(proof: any, auditRoot: string): Promise<FinalCandidateProofEvidence | undefined> {
  if (!Object.prototype.hasOwnProperty.call(proof || {}, "composition")) return undefined;
  const proofHash = digest(canonical(proof));
  const composition = JSON.parse(JSON.stringify(proof.composition));
  keys(composition, ["version", "components"], "composition");
  if (composition.version !== 1 || !Array.isArray(composition.components) || !composition.components.length) fail("invalid composition version/components");
  const rootPath = resolve(auditRoot), root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) fail("audit root must be a directory");
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const bounded = (path: string) => { if (!inside(root, path)) fail("artifact escapes the private audit root"); };
  const cache = new Map<string, Artifact>();
  const reads: { path: string; real: string; SHA256: string }[] = [];
  async function artifact(reference: Reference): Promise<Artifact> {
    if (typeof reference.path !== "string" || !reference.path.trim() || !safeHash(reference.SHA256)) fail("invalid artifact reference");
    const path = resolve(rootPath, reference.path);
    // macOS may name the same private root through /var and /private/var.
    if (!inside(rootPath, path) && !inside(root, path)) fail("artifact escapes the private audit root");
    const real = await realpath(path); bounded(real);
    if (!(await stat(real)).isFile()) fail("artifact must be a regular file");
    let loaded = cache.get(real);
    if (!loaded) {
      const raw = await readFile(real);
      loaded = { SHA256: digest(raw), value: freezeJSON(JSON.parse(raw.toString("utf8"))) };
      cache.set(real, loaded);
    }
    if (loaded.SHA256 !== reference.SHA256) fail("artifact SHA256 mismatch");
    reads.push({ path, real, SHA256: reference.SHA256 });
    return loaded;
  }
  const components: LoadedComponent[] = [];
  for (const descriptor of composition.components as Component[]) {
    keys(descriptor, ["kind", "inputs", "sources", "checkpoints", "selectedCandidateIds", ...(descriptor.proof ? ["proof"] : [])], "component");
    if (!["historical", "fresh"].includes(descriptor.kind) || descriptor.kind === "historical" && !descriptor.proof) fail("historical component requires its original complete proof");
    keys(descriptor.inputs, ["path", "SHA256"], "input reference");
    if (descriptor.proof) keys(descriptor.proof, ["path", "SHA256"], "proof reference");
    if (!Array.isArray(descriptor.sources) || descriptor.sources.length !== bindingKeys.length || new Set(descriptor.sources.map(source => source.bindingKey)).size !== bindingKeys.length) fail("exact four source references required");
    const sources = new Map<string, Artifact>();
    for (const source of descriptor.sources) {
      keys(source, ["bindingKey", "path", "SHA256"], "source reference");
      if (!(bindingKeys as readonly string[]).includes(source.bindingKey)) fail("unknown source binding key");
      sources.set(source.bindingKey, await artifact(source));
    }
    if (!Array.isArray(descriptor.selectedCandidateIds) || !descriptor.selectedCandidateIds.length || descriptor.selectedCandidateIds.some(id => !safeId(id)) || new Set(descriptor.selectedCandidateIds).size !== descriptor.selectedCandidateIds.length) fail("selected candidate IDs invalid/duplicated");
    if (!Array.isArray(descriptor.checkpoints) || !descriptor.checkpoints.length) fail("actual checkpoints required");
    const checkpoints: LoadedComponent["checkpoints"] = [];
    for (const reference of descriptor.checkpoints) {
      keys(reference, ["candidateId", "path", "SHA256", "job", "result"], "checkpoint reference");
      if (!safeId(reference.candidateId)) fail("invalid checkpoint candidate ID");
      keys(reference.job, ["path", "SHA256"], "job reference"); keys(reference.result, ["path", "SHA256"], "result reference");
      checkpoints.push({ reference, checkpoint: await artifact(reference), job: await artifact(reference.job), result: await artifact(reference.result) });
    }
    components.push({ descriptor, sources, checkpoints, inputs: await artifact(descriptor.inputs), proof: descriptor.proof ? await artifact(descriptor.proof) : undefined });
  }
  // References sharing a real path use one initial read; all exact bytes and path bounds are rechecked before evidence is issued.
  if (await realpath(rootPath) !== root) fail("audit root changed while loading");
  const checked = new Set<string>();
  for (const read of reads) {
    const real = await realpath(read.path); bounded(real);
    if (real !== read.real || !(await stat(real)).isFile()) fail("artifact path changed while loading");
    if (!checked.has(real)) {
      if (digest(await readFile(real)) !== read.SHA256) fail("artifact changed while loading");
      checked.add(real);
    }
  }
  if (digest(canonical(proof)) !== proofHash) fail("proof changed while loading");
  const evidence = Object.freeze({}) as FinalCandidateProofEvidence;
  evidenceStates.set(evidence, { proofHash, components });
  return evidence;
}

/** Proves where each current judgment was actually executed; this never rewrites checkpoints. */
export function validateFinalCandidateProofEvidence(evidence: FinalCandidateProofEvidence | undefined, proof: any, currentInputs: any[], bindings: Record<string, string>, policy: FinalCandidateProofEvidencePolicy): void {
  if (!Object.prototype.hasOwnProperty.call(proof || {}, "composition")) {
    if (evidence !== undefined) fail("unexpected evidence for an ordinary proof");
    return;
  }
  const loaded = evidence && evidenceStates.get(evidence);
  if (!loaded || loaded.proofHash !== digest(canonical(proof))) fail("missing, spoofed or stale opaque evidence");
  keys(bindings, bindingKeys, "current bindings");
  if (bindingKeys.some(key => !safeHash(bindings[key]))) fail("invalid current bindings");
  if (!Array.isArray(currentInputs) || currentInputs.some(input => !safeId(input?.candidateId) || !validAuthors(input)) || new Set(currentInputs.map(input => input.candidateId)).size !== currentInputs.length) fail("current inputs/authors invalid/duplicated");
  if (policy.promptHash !== digest(policy.helperVersion + policy.instructions + JSON.stringify(policy.schema))) fail("current instructions/schema mismatch with prompt hash");
  const currentMetadata = {version:1,helperVersion:policy.helperVersion,mode:"final",model:policy.model,sourceHash:digest(JSON.stringify(bindings)),scopeHash:digest(JSON.stringify(currentInputs)),promptHash:policy.promptHash,bindings,totalScope:currentInputs.length,offset:0,selected:currentInputs.length};
  if (metadataKeys.some(key => !isDeepStrictEqual(proof[key], (currentMetadata as any)[key])) || proof.fullScopeComplete !== true || proof.completed !== currentInputs.length || proof.pending !== 0) fail("current aggregate metadata/coverage mismatch");
  const currentById = new Map(currentInputs.map(input => [input.candidateId, input]));
  const selected = new Map<string, { entry: any; execution: any }>();
  for (const component of loaded.components) {
    const full = component.inputs.value;
    keys(full, [...metadataKeys, "entries"], "full inputs artifact");
    const inputs = full.entries;
    if (!Array.isArray(inputs) || !inputs.length || inputs.some(input => !safeId(input?.candidateId) || !validAuthors(input)) || new Set(inputs.map(input => input.candidateId)).size !== inputs.length) fail("component inputs/authors invalid/duplicated");
    const sourceBindings = Object.fromEntries(bindingKeys.map(key => [key, component.sources.get(key)!.SHA256]));
    keys(full.bindings, bindingKeys, "component bindings");
    if (full.version !== 1 || full.mode !== "final" || full.helperVersion !== policy.helperVersion || full.model !== policy.model || full.promptHash !== policy.promptHash || full.sourceHash !== digest(JSON.stringify(sourceBindings)) || full.scopeHash !== digest(JSON.stringify(inputs)) || full.totalScope !== inputs.length || full.offset !== 0 || full.selected !== inputs.length || !isDeepStrictEqual(full.bindings, sourceBindings)) fail("component source/scope/prompt/model metadata mismatch");
    const catalog = component.sources.get("catalogReviewSHA256")!.value, additions = component.sources.get("additionReviewSHA256")!.value, map = component.sources.get("candidateMapSHA256")!.value, provenance = component.sources.get("provenanceSHA256")!.value;
    if (map.reviewHash !== sourceBindings.catalogReviewSHA256 || provenance.reviewSHA256 !== sourceBindings.additionReviewSHA256 || !safeHash(catalog.sourceHash) || map.sourceHash !== catalog.sourceHash || !safeHash(additions.sourceHash) || map.candidateSnapshotSHA256 !== additions.sourceHash || provenance.snapshotSHA256 !== additions.sourceHash) fail("component source cross-bindings mismatch");
    if (component.descriptor.kind === "fresh" && (!isDeepStrictEqual(sourceBindings, bindings) || !sameJSON(inputs, currentInputs))) fail("fresh inputs/sources must equal the entire current scope");
    const metadata = Object.fromEntries(metadataKeys.map(key => [key, full[key]]));
    const byId = new Map(inputs.map((input: any) => [input.candidateId, input]));
    const historical = component.proof?.value;
    if (historical) {
      if (Object.prototype.hasOwnProperty.call(historical, "composition")) fail("nested composition is forbidden");
      if (historical.fullScopeComplete !== true || historical.completed !== inputs.length || historical.pending !== 0) fail("component proof coverage incomplete");
      policy.validateOrdinaryProof(historical, inputs, sourceBindings);
      for (const key of metadataKeys) if (!isDeepStrictEqual(historical[key], metadata[key])) fail("component proof metadata differs from full inputs");
    }
    const wanted = component.descriptor.kind === "historical" ? inputs.map((input: any) => input.candidateId) : component.descriptor.selectedCandidateIds;
    const cpById = new Map<string, { entry: any; execution: any }>();
    for (const record of component.checkpoints) {
      const candidateId = record.reference.candidateId, input: any = byId.get(candidateId), cp = record.checkpoint.value, job = record.job.value, result = record.result.value;
      if (!input || cpById.has(candidateId)) fail("checkpoint candidate missing/duplicated");
      keys(cp, [...metadataKeys, "inputHash", "completedAt", "execution", "entry"], "checkpoint");
      if (metadataKeys.some(key => !isDeepStrictEqual(cp[key], metadata[key])) || cp.inputHash !== digest(JSON.stringify(input)) || typeof cp.completedAt !== "string" || !Number.isFinite(Date.parse(cp.completedAt))) fail("checkpoint metadata/input/timestamp mismatch");
      keys(job, ["version", "execution", "mode", "metadata", "instructions", "schema", "entries"], "job");
      if (job.version !== 1 || job.execution !== "codex-agent" || job.mode !== "final" || !isDeepStrictEqual(job.metadata, metadata) || job.instructions !== policy.instructions || !isDeepStrictEqual(job.schema, policy.schema) || !Array.isArray(job.entries) || !job.entries.length || job.entries.length > 40) fail("actual job metadata/instructions/schema mismatch");
      const jobIds = new Set<string>();
      for (const jobInput of job.entries) {
        if (!safeId(jobInput?.candidateId) || jobIds.has(jobInput.candidateId) || !sameJSON(jobInput, byId.get(jobInput.candidateId))) fail("actual job full input changed/duplicated");
        jobIds.add(jobInput.candidateId);
      }
      if (!jobIds.has(candidateId)) fail("checkpoint is absent from its actual job");
      keys(result, ["entries"], "actual result");
      policy.validateDecisions(result, job.entries);
      policy.validateDecisions({ entries: [cp.entry] }, [input]);
      const resultEntry = result.entries.find((entry: any) => entry.candidateId === candidateId);
      if (!isDeepStrictEqual(cp.entry, resultEntry)) fail("actual result differs from checkpoint decision");
      keys(cp.execution, ["kind", "agent", "reasoningEffort", "jobSHA256", "resultSHA256"], "checkpoint execution");
      if (cp.execution.kind !== "codex-agent" || !/^\/root\/[a-z\d_]+$/u.test(cp.execution.agent) || !["high", "xhigh"].includes(cp.execution.reasoningEffort) || job.entries.some((jobInput: any) => !jobInput.authors || [jobInput.authors.draftAgent, jobInput.authors.reviewAgent].includes(cp.execution.agent)) || cp.execution.jobSHA256 !== record.job.SHA256 || cp.execution.resultSHA256 !== record.result.SHA256) fail("actual third-author/effort/job/result execution mismatch");
      const execution = { candidateId, ...cp.execution, completedAt: cp.completedAt };
      if (historical && (!isDeepStrictEqual(historical.entries.find((entry: any) => entry.candidateId === candidateId), cp.entry) || !isDeepStrictEqual(historical.executions.find((stamp: any) => stamp.candidateId === candidateId), execution))) fail("original proof decision/execution differs from actual checkpoint");
      cpById.set(candidateId, { entry: cp.entry, execution });
    }
    if (cpById.size !== wanted.length || wanted.some((candidateId: string) => !cpById.has(candidateId))) fail("component actual checkpoint coverage incomplete/extra");
    for (const candidateId of component.descriptor.selectedCandidateIds) {
      const current: any = currentById.get(candidateId), original: any = byId.get(candidateId), actual = cpById.get(candidateId);
      if (!current || !actual || selected.has(candidateId)) fail("selected candidate missing/duplicated");
      if (!sameJSON(original, current)) fail("entire original/current input differs; actual fresh review required");
      if (!current.authors || [current.authors.draftAgent, current.authors.reviewAgent].includes(actual.execution.agent)) fail("current third author is not independent");
      selected.set(candidateId, actual);
    }
  }
  if (selected.size !== currentInputs.length || currentInputs.some(input => !selected.has(input.candidateId))) fail("current selected coverage incomplete");
  policy.validateOrdinaryProof(proof, currentInputs, bindings);
  for (const [candidateId, actual] of selected) {
    if (!isDeepStrictEqual(proof.entries.find((entry: any) => entry.candidateId === candidateId), actual.entry) || !isDeepStrictEqual(proof.executions.find((stamp: any) => stamp.candidateId === candidateId), actual.execution)) fail("current aggregate decision/execution differs from selected actual checkpoint");
  }
}
