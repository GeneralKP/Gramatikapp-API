import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFinalCandidateProofEvidence, validateFinalCandidateProofEvidence, type FinalCandidateProofEvidence, type FinalCandidateProofEvidencePolicy } from "./lib/finalCandidateProofEvidence.js";
import { FINAL_CANDIDATE_VERSION, FINAL_CANDIDATE_MODEL, FINAL_CANDIDATE_PROMPT_HASH, FINAL_CANDIDATE_INSTRUCTIONS, FINAL_CANDIDATE_SCHEMA, validateFinalCandidateDecisions, validateFinalCandidateProof } from "./reviewFinalWordCardCandidates.js";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const hex = (index: number) => index.toString(16).padStart(24, "0");
const clone = <T>(value: T): T => structuredClone(value);
const policy: FinalCandidateProofEvidencePolicy = {
  helperVersion: FINAL_CANDIDATE_VERSION, model: FINAL_CANDIDATE_MODEL, promptHash: FINAL_CANDIDATE_PROMPT_HASH,
  instructions: FINAL_CANDIDATE_INSTRUCTIONS, schema: FINAL_CANDIDATE_SCHEMA,
  validateDecisions: validateFinalCandidateDecisions,
  validateOrdinaryProof: (proof,inputs,bindings) => {
    const {composition: _composition, ...ordinary} = proof;
    return validateFinalCandidateProof(ordinary,inputs,bindings);
  },
};
const input = (index: number) => {
  const forms = {gender:"",plural:"",perfect:"hat geprüft",past:"ich prüfte",imperativ:"prüf!, prüft!",gramaticalCase:"Akkusativ",irregularConjugations:""};
  const candidate = {id:hex(index+100),candidateId:hex(index),german:"etwas prüfen",spanish:"algo comprobar",requestedSense:{senseKey:`fixture:${index}`,forms},relatedFrom:[{entryId:hex(900)}]};
  const variant = {german:"etwas prüfen",category:"VERB",forms,notes:"hat geprüft\nich prüfte\nprüf!, prüft!",examples:["Ich prüfe den Plan.","Prüf bitte das Ergebnis!"],confidence:"high",reviewReason:"Synthetic fixture"};
  const actualEntry = {id:hex(index+100),...variant,studyEligible:true,issues:[],relatedCandidates:[],translations:[{relationId:hex(index),spanish:"algo comprobar",examples:["Compruebo el plan.","¡Comprueba el resultado, por favor!"],variant}]};
  return {candidateId:hex(index),originalCandidate:candidate,aliasedIntentions:[{...candidate,candidateId:hex(index+200),terminalCandidateId:hex(index)}],sourceEntries:[{id:hex(900),german:"Die Prüfung",forms:{gender:"feminine",plural:"Prüfungen"}}],actualEntry,authors:{draftAgent:"/root/fixture_draft",reviewAgent:"/root/fixture_review"},german:variant.german,category:variant.category,forms,notes:variant.notes,spanish:"algo comprobar",potentialMatches:[],alternativeCandidates:[]};
};
const decision = (candidateId: string) => ({candidateId,intention:"preserved",decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Synthetic actual-review result for an absent checking sense."});
const directory = await mkdtemp(join(tmpdir(), "final-candidate-evidence-"));
const outside = await mkdtemp(join(tmpdir(), "final-candidate-outside-"));
let serial = 0;
async function artifact(name: string, value: any) {
  const path = join(directory, `${++serial}-${name}.json`), raw = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, raw, {mode:0o600});
  return {path,SHA256:sha(raw)};
}
async function sources(tag: string) {
  const catalog = await artifact(`catalog-${tag}`, {sourceHash:sha("snapshot"),tag});
  const additions = await artifact(`additions-${tag}`, {sourceHash:sha("candidates"),tag});
  const map = await artifact(`map-${tag}`, {sourceHash:sha("snapshot"),reviewHash:catalog.SHA256,candidateSnapshotSHA256:sha("candidates"),tag});
  const provenance = await artifact(`provenance-${tag}`, {snapshotSHA256:sha("candidates"),reviewSHA256:additions.SHA256,tag});
  return [
    {bindingKey:"catalogReviewSHA256",...catalog},{bindingKey:"additionReviewSHA256",...additions},
    {bindingKey:"candidateMapSHA256",...map},{bindingKey:"provenanceSHA256",...provenance},
  ];
}
const bind = (refs: any[]) => Object.fromEntries(refs.map(ref => [ref.bindingKey,ref.SHA256]));
const metadata = (inputs: any[], bindings: any) => ({version:1,helperVersion:FINAL_CANDIDATE_VERSION,mode:"final",model:FINAL_CANDIDATE_MODEL,sourceHash:sha(JSON.stringify(bindings)),scopeHash:sha(JSON.stringify(inputs)),promptHash:FINAL_CANDIDATE_PROMPT_HASH,bindings,totalScope:inputs.length,offset:0,selected:inputs.length});
async function component(kind: "historical" | "fresh", inputs: any[], refs: any[], selected: string[], executed = inputs) {
  const meta = metadata(inputs,bind(refs));
  const jobValue = {version:1,execution:"codex-agent",mode:"final",metadata:meta,instructions:FINAL_CANDIDATE_INSTRUCTIONS,schema:FINAL_CANDIDATE_SCHEMA,entries:clone(executed)};
  const resultValue = {entries:executed.map(value=>decision(value.candidateId))};
  const job = await artifact("job",jobValue), result = await artifact("result",resultValue);
  const checkpointValues = executed.map((value,index)=>({...meta,inputHash:sha(JSON.stringify(value)),completedAt:`2026-10-08T12:00:0${index}.000Z`,execution:{kind:"codex-agent",agent:"/root/fixture_third",reasoningEffort:"xhigh",jobSHA256:job.SHA256,resultSHA256:result.SHA256},entry:resultValue.entries[index]}));
  const checkpoints = await Promise.all(checkpointValues.map(async value=>({candidateId:value.entry.candidateId,...await artifact("checkpoint",value),job,result})));
  const proofValue = {...meta,fullScopeComplete:true,completed:inputs.length,pending:0,entries:checkpointValues.map(value=>value.entry),executions:checkpointValues.map(value=>({candidateId:value.entry.candidateId,...value.execution,completedAt:value.completedAt}))};
  const descriptor: any = {kind,inputs:await artifact("inputs",{...meta,entries:inputs}),sources:refs,checkpoints,selectedCandidateIds:selected};
  if (kind === "historical") descriptor.proof = await artifact("proof",proofValue);
  return {descriptor,checkpointValues,jobValue,resultValue,proofValue};
}
async function fixture() {
  const historicalInputs = [input(1),input(2)], currentInputs = [...clone(historicalInputs),input(3)];
  const oldSources = await sources("old"), currentSources = await sources("current");
  const old = await component("historical",historicalInputs,oldSources,historicalInputs.map(value=>value.candidateId));
  const fresh = await component("fresh",currentInputs,currentSources,[hex(3)],[currentInputs[2]]);
  const selected = [...old.checkpointValues,...fresh.checkpointValues];
  const proof = {...metadata(currentInputs,bind(currentSources)),fullScopeComplete:true,completed:currentInputs.length,pending:0,entries:selected.map(value=>value.entry),executions:selected.map(value=>({candidateId:value.entry.candidateId,...value.execution,completedAt:value.completedAt})),composition:{version:1,components:[old.descriptor,fresh.descriptor]}};
  return {proof,currentInputs,bindings:bind(currentSources),old,fresh};
}
async function validate(value: Awaited<ReturnType<typeof fixture>>, selectedPolicy = policy) {
  const evidence = await loadFinalCandidateProofEvidence(value.proof,directory);
  validateFinalCandidateProofEvidence(evidence,value.proof,value.currentInputs,value.bindings,selectedPolicy);
  return evidence;
}
async function replaceReference(reference: any, value: any) {
  const updated = await artifact("altered",value);
  reference.path = updated.path; reference.SHA256 = updated.SHA256;
}
async function changeCheckpoint(value: Awaited<ReturnType<typeof fixture>>, which: "old" | "fresh", index: number, change: (cp: any)=>void) {
  const cp = clone(value[which].checkpointValues[index]); change(cp);
  await replaceReference(value[which].descriptor.checkpoints[index],cp);
}

try {
  const good = await fixture();
  assert.notEqual(good.old.descriptor.sources[0].SHA256,good.bindings.catalogReviewSHA256,"Whole source bytes genuinely changed while the selected full inputs remained identical");
  await validate(good);
  const ordinary = {...good.old.proofValue};
  assert.equal(await loadFinalCandidateProofEvidence(ordinary,"/not-read-for-ordinary-proof"),undefined);
  validateFinalCandidateProofEvidence(undefined,ordinary,[],{},policy);
  assert.throws(()=>validateFinalCandidateProofEvidence({} as FinalCandidateProofEvidence,good.proof,good.currentInputs,good.bindings,policy),/spoofed/);
  const evidence = await validate(good);
  assert.equal(validateFinalCandidateProof(good.proof,good.currentInputs,good.bindings,evidence).length,3,"The public validator accepts composition only after actual artifact loading");
  assert.throws(()=>validateFinalCandidateProof(good.proof,good.currentInputs,good.bindings),/missing, spoofed/);
  assert.throws(()=>validateFinalCandidateProof(good.proof,good.currentInputs,good.bindings,{} as FinalCandidateProofEvidence),/spoofed/);
  const changedProof = clone(good.proof); changedProof.entries[0].reason += " Rebound.";
  assert.throws(()=>validateFinalCandidateProofEvidence(evidence,changedProof,good.currentInputs,good.bindings,policy),/stale opaque/);

  // Every field in the supplied full evidence matters, not just the canonical front/forms.
  for (const change of [
    (value: any)=>{value.aliasedIntentions[0].requestedSense.forms.gramaticalCase="Dativ";},
    (value: any)=>{value.sourceEntries[0].forms.plural="";},
    (value: any)=>{value.actualEntry.translations[0].examples[0]="Otro sentido.";},
    (value: any)=>{value.potentialMatches.push({relationId:hex(777),ready:true});},
    (value: any)=>{value.alternativeCandidates.push({candidateId:hex(888),ready:true});},
    (value: any)=>{value.authors.reviewAgent="/root/another_reviewer";},
  ]) {
    const bad = await fixture(); change(bad.currentInputs[0]);
    bad.proof.scopeHash=sha(JSON.stringify(bad.currentInputs));
    await assert.rejects(()=>validate(bad),/entire original\/current input differs/);
  }
  const reordered = await fixture();
  reordered.currentInputs[0] = Object.fromEntries(Object.entries(reordered.currentInputs[0]).reverse()) as any;
  reordered.proof.scopeHash=sha(JSON.stringify(reordered.currentInputs));
  await assert.rejects(()=>validate(reordered),/entire original\/current input differs/,"Deep equality with different input serialization is insufficient for reuse");
  const wrongSource = await fixture(); wrongSource.old.descriptor.sources[0].SHA256="0".repeat(64);
  await assert.rejects(()=>validate(wrongSource),/SHA256 mismatch/);
  const mismatchedSource = await fixture();
  await replaceReference(mismatchedSource.old.descriptor.sources[0],{sourceHash:sha("snapshot"),tag:"unexpected actual bytes"});
  await assert.rejects(()=>validate(mismatchedSource),/metadata mismatch/);
  const alteredFile = await fixture(); await writeFile(alteredFile.old.descriptor.checkpoints[0].result.path,"{}\n");
  await assert.rejects(()=>validate(alteredFile),/SHA256 mismatch/);
  const wrongResult = await fixture();
  const otherResult = clone(wrongResult.old.resultValue); otherResult.entries[0].reason="Different actual judgment.";
  const newResult = await artifact("different-result",otherResult);
  wrongResult.old.descriptor.checkpoints.forEach(cp=>{cp.result=newResult;});
  await assert.rejects(()=>validate(wrongResult),/actual result differs/);
  const wrongJob = await fixture();
  const changedJob = clone(wrongJob.old.jobValue); changedJob.entries[1].sourceEntries[0].forms.plural="Changed job evidence";
  const newJob = await artifact("different-job",changedJob);
  wrongJob.old.descriptor.checkpoints.forEach(cp=>{cp.job=newJob;});
  await assert.rejects(()=>validate(wrongJob),/actual job full input changed/);
  const changedInstructions = await fixture();
  await assert.rejects(()=>validate(changedInstructions,{...policy,instructions:policy.instructions+" A new instruction."}),/instructions\/schema mismatch/);
  const changedSchema = await fixture();
  await assert.rejects(()=>validate(changedSchema,{...policy,schema:{...policy.schema,description:"Changed schema"}}),/instructions\/schema mismatch/);
  const incompleteOld = await fixture(); incompleteOld.old.descriptor.checkpoints.pop();
  await assert.rejects(()=>validate(incompleteOld),/coverage incomplete/);
  const duplicateOld = await fixture(); duplicateOld.old.descriptor.checkpoints.push(incompleteOld.old.descriptor.checkpoints[0]);
  await assert.rejects(()=>validate(duplicateOld),/checkpoint candidate missing\/duplicated/);
  const duplicateSelection = await fixture(); duplicateSelection.fresh.descriptor.selectedCandidateIds.push(hex(1));
  await assert.rejects(()=>validate(duplicateSelection),/coverage incomplete\/extra/);
  const overlapping = await fixture(); overlapping.proof.composition.components.push(clone(overlapping.old.descriptor));
  await assert.rejects(()=>validate(overlapping),/selected candidate missing\/duplicated/);
  const omittedSelection = await fixture(); omittedSelection.old.descriptor.selectedCandidateIds.pop();
  await assert.rejects(()=>validate(omittedSelection),/current selected coverage incomplete/);
  const reboundDecision = await fixture(); reboundDecision.proof.entries[0].reason="A new aggregate-only decision.";
  await assert.rejects(()=>validate(reboundDecision),/current aggregate decision\/execution differs/);
  const reboundStamp = await fixture(); reboundStamp.proof.executions[0].completedAt="2026-10-09T12:00:00.000Z";
  await assert.rejects(()=>validate(reboundStamp),/current aggregate decision\/execution differs/);
  const mismatchFresh = await fixture();
  await changeCheckpoint(mismatchFresh,"fresh",0,cp=>{cp.inputHash=sha("unrelated input");});
  await assert.rejects(()=>validate(mismatchFresh),/checkpoint metadata\/input\/timestamp mismatch/);
  const reboundJobHash = await fixture();
  await changeCheckpoint(reboundJobHash,"old",0,cp=>{cp.execution.jobSHA256="0".repeat(64);});
  await assert.rejects(()=>validate(reboundJobHash),/execution mismatch/);
  const sameAuthor = await fixture();
  await changeCheckpoint(sameAuthor,"old",0,cp=>{cp.execution.agent="/root/fixture_draft";});
  await assert.rejects(()=>validate(sameAuthor),/third-author/);
  const wrongEffort = await fixture();
  await changeCheckpoint(wrongEffort,"old",0,cp=>{cp.execution.reasoningEffort="low";});
  await assert.rejects(()=>validate(wrongEffort),/effort/);
  const nested = await fixture();
  await replaceReference(nested.old.descriptor.proof,{...nested.old.proofValue,composition:{version:1,components:[]}});
  await assert.rejects(()=>validate(nested),/nested composition/);
  const partialHistorical = await fixture(); delete partialHistorical.old.descriptor.proof;
  await assert.rejects(()=>validate(partialHistorical),/requires its original complete proof/);
  const staleFresh = await fixture();
  const staleInputs = {...metadata(staleFresh.currentInputs,bind(staleFresh.old.descriptor.sources)),entries:staleFresh.currentInputs};
  staleFresh.fresh.descriptor.sources=clone(staleFresh.old.descriptor.sources);
  await replaceReference(staleFresh.fresh.descriptor.inputs,staleInputs);
  await assert.rejects(()=>validate(staleFresh),/fresh inputs\/sources/);
  const external = await fixture();
  const outsidePath = join(outside,"external.json"), outsideRaw=JSON.stringify(external.old.proofValue);
  await writeFile(outsidePath,outsideRaw);
  external.old.descriptor.proof={path:outsidePath,SHA256:sha(outsideRaw)};
  await assert.rejects(()=>validate(external),/escapes/);
  const linkedOutside = await fixture();
  const link = join(directory,"outside-link.json"); await symlink(outsidePath,link);
  linkedOutside.old.descriptor.proof={path:link,SHA256:sha(outsideRaw)};
  await assert.rejects(()=>validate(linkedOutside),/escapes/);
  const nonfile = await fixture(); const folder=join(directory,"not-a-file"); await mkdir(folder);
  nonfile.old.descriptor.proof={path:folder,SHA256:sha("folder")};
  await assert.rejects(()=>validate(nonfile),/regular file/);
  // Input-relative references are permitted and remain rooted in the private audit directory.
  const relativeRefs = await fixture();
  relativeRefs.old.descriptor.inputs.path=relativeRefs.old.descriptor.inputs.path.slice(directory.length+1);
  await validate(relativeRefs);
  // Validation and loading leave every actual historical artifact unchanged.
  for (const cp of good.old.descriptor.checkpoints) assert.equal(sha(await readFile(cp.path,"utf8")),cp.SHA256);
} finally {
  await rm(directory,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true});
}
console.log("Final candidate evidence fixtures passed: genuine full-input reuse, actual execution/source checks, opaque proof binding, fresh scope and immutable historical artifacts. No database/provider calls.");
