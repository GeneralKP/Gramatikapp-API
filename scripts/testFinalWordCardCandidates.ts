import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFinalCandidateInputs, FINAL_CANDIDATE_VERSION, FINAL_CANDIDATE_MODEL, FINAL_CANDIDATE_INSTRUCTIONS, FINAL_CANDIDATE_SCHEMA, FINAL_CANDIDATE_PROMPT_HASH, validateFinalCandidateDecisions, validateFinalCandidateProof } from "./reviewFinalWordCardCandidates.js";
import { candidateSHA256, EXPECTED_CATALOG_REVIEW_HASH, permitsRequestedSenseCoverage } from "./reviewWordCardCandidates.js";
import { ingestHelperJob, makeHelperJob, validateHelperCheckpoint, type HelperContext } from "./agentWordCardHelpers.js";

const hex = (index: number) => index.toString(16).padStart(24, "0"), hash = "a".repeat(64);
const forms = { gender:"", plural:"", perfect:"hat gedacht", past:"ich dachte", imperativ:"denk!, denkt!", gramaticalCase:"an:Akkusativ", irregularConjugations:"" };
const entry = (index: number, relation: number, german = "an einen Plan denken", issues: string[] = []) => {
  const variant = {german, category:"VERB", forms, notes:"hat gedacht\nich dachte\ndenk!, denkt!", examples:["Ich denke an meinen Plan.", "Denk bitte an den Plan!"], confidence:"high", reviewReason:"Named case cue in a controlled fixture"};
  return {id:hex(index), ...variant, studyEligible:true, issues, relatedCandidates:[], translations:[{relationId:hex(relation),spanish:"en un plan pensar", examples:["Pienso en mi plan.", "¡Piensa en el plan, por favor!"], variant}]};
};
const review = (entries: any[], sourceHash: string) => ({version:1,stage:"independent_review",promptHash:EXPECTED_CATALOG_REVIEW_HASH,sourceHash,offset:0,selected:entries.length,completed:entries.length,pending:0,entries});
const catalog = review([entry(90,91),entry(92,93,"an einen Plan denken",["cannot_auto_apply: fixture uncertainty"])],"b".repeat(64));
const additions = review([entry(10,11),entry(20,21)],hash);
const candidates = [
  {id:hex(10),candidateId:hex(11),german:"an etwas denken",spanish:"en algo pensar",requestedSense:{senseKey:"fixture:thinking-thing",reasons:["Thing-directed thinking"],forms:{}},relatedFrom:[{entryId:hex(90)}]},
  {id:hex(20),candidateId:hex(21),german:"an einen Plan denken",spanish:"en un plan pensar",requestedSense:{senseKey:"fixture:plan",reasons:["Thinking of a plan"],forms:{}},relatedFrom:[{entryId:hex(90)}]},
];
const map = {finalized:true,partial:false,candidates,coveredCandidates:[],candidateSnapshotSHA256:hash,sourceHash:catalog.sourceHash,reviewHash:hash};
const authors = {draftAgent:"/root/fixture_draft",reviewAgent:"/root/fixture_review",model:FINAL_CANDIDATE_MODEL,draftEffort:"xhigh",reviewEffort:"high",draftCheckpointSHA256:hash,reviewCheckpointSHA256:hash};
const provenance = {snapshotSHA256:hash,reviewSHA256:hash,entries:additions.entries.map(entry => ({id:entry.id,...authors}))};
const originalBytes = JSON.stringify({catalog,additions,map,provenance});
const inputs = buildFinalCandidateInputs(catalog,additions,map,provenance,2);
assert.equal(inputs.length,2,"A corrected front pulls in all actual peers, including unchanged seeds");
assert.equal(inputs[0].sourceEntries.length,1);
assert.equal(inputs[0].potentialMatches.find((match: any) => match.relationId === hex(93)).ready,false,"Active blockers never become coverage");
assert.equal(JSON.stringify({catalog,additions,map,provenance}),originalBytes,"Preparing evidence never edits seeds/reviews");
const unchangedMap = structuredClone(map);
unchangedMap.candidates[0].german = additions.entries[0].translations[0].variant.german;
unchangedMap.candidates[0].spanish = additions.entries[0].translations[0].spanish;
assert.equal(buildFinalCandidateInputs(catalog,additions,unchangedMap,provenance,2).length,2,"Actual canonical peers require semantic dedup even when neither seed needed a grammatical correction");
const singleAddition = review([additions.entries[0]],hash);
const singleMap = {...unchangedMap,candidates:[unchangedMap.candidates[0]]};
const singleProvenance = {...provenance,entries:[provenance.entries[0]]};
assert.equal(buildFinalCandidateInputs(catalog,singleAddition,singleMap,singleProvenance,2).length,1,"An unchanged seed matching an original canonical front still needs a semantic coverage decision");
const unrelatedCatalog = review([entry(90,91,"an eine Reise denken"),entry(92,93,"an einen Urlaub glauben")],catalog.sourceHash);
assert.equal(buildFinalCandidateInputs(unrelatedCatalog,singleAddition,singleMap,singleProvenance,2).length,0,"An unchanged solitary actual front needs no redundant third pass");
// An unchanged representative can still carry a fallible merged intention.
// Scope inclusion supplies evidence to the third reviewer; it approves no meaning.
const aliasWithChangedCase = {
  id:hex(30),candidateId:hex(31),german:singleMap.candidates[0].german,spanish:singleMap.candidates[0].spanish,
  requestedSense:{senseKey:"fixture:aliased-case",reasons:["Synthetic alias with conflicting requested case metadata"],forms:{...forms,gramaticalCase:"an:Dativ"}},
  relatedFrom:[{entryId:hex(92)}],
  decision:{candidateId:hex(31),decision:"covered",coveredByIDs:[],coveredByCandidateIds:[hex(11)],reason:"Synthetic prior alias evidence, not final semantic approval"},
  terminalCandidateId:hex(11),existingMatches:[],
};
const aliasChangedMap = {...singleMap,coveredCandidates:[aliasWithChangedCase]};
const aliasSourceBytes = JSON.stringify({unrelatedCatalog,singleAddition,aliasChangedMap,singleProvenance});
assert.equal(permitsRequestedSenseCoverage(singleMap.candidates[0],singleAddition.entries[0].translations[0].variant,true),true,"The representative itself is unchanged and compatible");
assert.equal(permitsRequestedSenseCoverage(aliasWithChangedCase,singleAddition.entries[0].translations[0].variant,true),false,"Only the merged alias has conflicting explicit case evidence");
const aliasChangedInputs = buildFinalCandidateInputs(unrelatedCatalog,singleAddition,aliasChangedMap,singleProvenance,2);
assert.equal(aliasChangedInputs.length,1,"An unchanged representative with an incompatible aliased intention must enter the final review scope");
assert.deepEqual(aliasChangedInputs[0].originalCandidate,singleMap.candidates[0]);
assert.deepEqual(aliasChangedInputs[0].aliasedIntentions,[aliasWithChangedCase],"The complete original alias, requested forms and prior coverage evidence reach the reviewer");
assert.deepEqual(aliasChangedInputs[0].actualEntry,singleAddition.entries[0]);
assert.deepEqual(aliasChangedInputs[0].sourceEntries,unrelatedCatalog.entries,"Both representative and alias origins are supplied");
assert.equal(JSON.stringify({unrelatedCatalog,singleAddition,aliasChangedMap,singleProvenance}),aliasSourceBytes,"Alias scope preparation never edits original evidence");
const changedSpanishMap = structuredClone(singleMap);
changedSpanishMap.candidates[0].spanish = "en algo pensar";
assert.equal(buildFinalCandidateInputs(unrelatedCatalog,singleAddition,changedSpanishMap,singleProvenance,2).length,1,"A rewritten Spanish cue requires an intention check even when front/forms match the seed");
assert.equal(buildFinalCandidateInputs(unrelatedCatalog,additions,unchangedMap,provenance,2).length,2,"All same-front actual peers are included even without a matching original relation");
// Changing only a short case-example noun must still reach a semantic reviewer.
// The shape is comparison evidence, never a claim that the meanings are equal.
const manifestation = (index: number, relation: number, noun: string) => {
  const value = entry(index,relation,`sich in einem ${noun} widerspiegeln`);
  value.forms = {...forms,perfect:"hat sich widergespiegelt",past:"es spiegelte sich wider",imperativ:"",gramaticalCase:"reflexive:Akkusativ; in + Dativ"};
  value.translations[0].variant = {...value.translations[0].variant,forms:value.forms,notes:"hat sich widergespiegelt\nes spiegelte sich wider"};
  return value;
};
const illustrationReview = review([manifestation(30,31,"Werk"),manifestation(40,41,"Text")],hash);
const illustrationMap = {...map,candidates:illustrationReview.entries.map(value=>({id:value.id,candidateId:value.translations[0].relationId,german:value.german,spanish:value.translations[0].spanish,requestedSense:{senseKey:"fixture:manifestation",reasons:["Illustrative location noun, same manifestation intention"],forms:{}},relatedFrom:[]}))};
const illustrationProvenance = {...provenance,entries:illustrationReview.entries.map(value=>({id:value.id,...authors}))};
const illustrationInputs = buildFinalCandidateInputs(unrelatedCatalog,illustrationReview,illustrationMap,illustrationProvenance,2);
assert.equal(illustrationInputs.length,2,"Werk/Text case illustrations with otherwise identical construction and case require actual semantic comparison");
assert.deepEqual(illustrationInputs[0].forms,illustrationReview.entries[0].translations[0].variant.forms,"Canonical relation forms, not fallible seed or top-level metadata, bind comparison evidence");
assert.equal(illustrationInputs[0].alternativeCandidates[0].candidateId,hex(41));
const illustrationDecision = {entries:[
  {candidateId:hex(31),intention:"preserved",decision:"missing",coveredByIDs:[],coveredByCandidateIds:[],reason:"Controlled fixture: same manifestation meaning, one case-example noun representative."},
  {candidateId:hex(41),intention:"preserved",decision:"covered",coveredByIDs:[],coveredByCandidateIds:[hex(31)],reason:"Controlled fixture: actual third reviewer has checked both full cards and every original intention."},
]};
validateFinalCandidateDecisions(illustrationDecision,illustrationInputs);
const distinctIntention = structuredClone(illustrationDecision);
distinctIntention.entries[1] = {...distinctIntention.entries[1],decision:"missing",coveredByCandidateIds:[],reason:"Controlled fixture: a real different sense must remain a separate card despite the comparable syntax."};
validateFinalCandidateDecisions(distinctIntention,illustrationInputs);
for (const change of [
  (value: any)=>{value.german="sich auf einem Text widerspiegeln";},
  (value: any)=>{value.german="sich in einen Text widerspiegeln";},
  (value: any)=>{value.german="in einem Text widerspiegeln";},
  (value: any)=>{value.forms.gramaticalCase="reflexive:Akkusativ; in + Akkusativ";},
  (value: any)=>{value.forms.gramaticalCase="";},
  (value: any)=>{value.category="NOUN";value.forms.gender="neuter";value.forms.plural="Texte";},
  (value: any)=>{value.notes="Redewendung";},
  (value: any)=>{value.german="sich in einem langen Text widerspiegeln";},
]) {
  const changed = structuredClone(illustrationInputs), peer = changed[1];
  change(peer);
  // Retaining a malicious/stale supplied peer must not make its changed case/front usable.
  changed[1].alternativeCandidates[0] = {...changed[0],candidateId:hex(31)};
  change(changed[1].alternativeCandidates[0]);
  // Make the source retain its original shape: only the target is incompatible.
  changed[1] = {...illustrationInputs[1],alternativeCandidates:changed[1].alternativeCandidates};
  assert.throws(()=>validateFinalCandidateDecisions(illustrationDecision,changed),/lower.*canonical/);
}
const illustrationOriginal = review([manifestation(90,91,"Gedicht"),entry(92,93,"an eine Reise denken")],catalog.sourceHash);
const originalComparison = buildFinalCandidateInputs(illustrationOriginal,review([illustrationReview.entries[0]],hash),{...illustrationMap,candidates:[illustrationMap.candidates[0]]},{...illustrationProvenance,entries:[illustrationProvenance.entries[0]]},2);
assert.equal(originalComparison.length,1,"A ready original with the same guarded case-example construction is supplied too");
validateFinalCandidateDecisions({entries:[{...illustrationDecision.entries[0],decision:"covered",coveredByIDs:[hex(91)]}]},originalComparison);
const decisions = {entries:[
  {candidateId:hex(11),intention:"preserved",decision:"covered",coveredByIDs:[hex(91)],coveredByCandidateIds:[],reason:"Fixture: same plan-thinking meaning in the ready original relation"},
  {candidateId:hex(21),intention:"preserved",decision:"covered",coveredByIDs:[],coveredByCandidateIds:[hex(11)],reason:"Fixture: lower peer resolves to the ready original plan-thinking relation"},
]};
validateFinalCandidateDecisions(decisions,inputs);
const alter = (change: (value: any) => void) => {const value=structuredClone(decisions);change(value);return value;};
assert.throws(()=>validateFinalCandidateDecisions(alter(value=>value.entries[0].coveredByIDs=[hex(93)]),inputs),/ready/);
assert.throws(()=>validateFinalCandidateDecisions(alter(value=>value.entries[0].coveredByIDs=[hex(999)]),inputs),/provided/);
assert.throws(()=>validateFinalCandidateDecisions(alter(value=>{value.entries[0].coveredByIDs=[];value.entries[0].coveredByCandidateIds=[hex(21)];}),inputs),/lower/);
assert.throws(()=>validateFinalCandidateDecisions(alter(value=>value.entries[0].intention="changed"),inputs),/Changed/);
assert.throws(()=>validateFinalCandidateDecisions(alter(value=>value.entries[0].coveredByCandidateIds=[hex(21)]),inputs),/references/);
assert.throws(()=>validateFinalCandidateDecisions({entries:[decisions.entries[0],decisions.entries[0]]},inputs),/Invalid/);
const bindings={catalogReviewSHA256:hash,additionReviewSHA256:hash,candidateMapSHA256:hash,provenanceSHA256:hash};
const metadata={version:1,helperVersion:FINAL_CANDIDATE_VERSION,mode:"final",model:FINAL_CANDIDATE_MODEL,sourceHash:candidateSHA256(JSON.stringify(bindings)),scopeHash:candidateSHA256(JSON.stringify(inputs)),promptHash:FINAL_CANDIDATE_PROMPT_HASH,bindings,totalScope:2,offset:0,selected:2};
const directory=await mkdtemp(join(tmpdir(),"final-word-card-fixture-"));
try {
  const controlled:HelperContext={mode:"final",metadata,inputs,instructions:FINAL_CANDIDATE_INSTRUCTIONS,schema:FINAL_CANDIDATE_SCHEMA,output:directory,protectedPaths:[]};
  const job=makeHelperJob(controlled,inputs), execution={agent:"/root/fixture_third",effort:"xhigh",jobSHA256:hash,resultSHA256:hash};
  await assert.rejects(()=>ingestHelperJob(job,decisions,controlled,{...execution,agent:authors.draftAgent}),/both previous/);
  await assert.rejects(()=>ingestHelperJob(job,decisions,controlled,{...execution,agent:authors.reviewAgent}),/both previous/);
  const result=await ingestHelperJob(job,decisions,controlled,execution);
  assert.equal(result.added,2);
  const checkpoints=await Promise.all(inputs.map(async input=>JSON.parse(await readFile(join(directory,"entries",`${input.candidateId}.json`),"utf8"))));
  checkpoints.forEach((checkpoint,index)=>validateHelperCheckpoint(checkpoint,inputs[index],controlled));
  const proof={...metadata,fullScopeComplete:true,completed:2,pending:0,entries:decisions.entries,executions:checkpoints.map(checkpoint=>({candidateId:checkpoint.entry.candidateId,...checkpoint.execution,completedAt:checkpoint.completedAt}))};
  validateFinalCandidateProof(proof,inputs,bindings);
  assert.throws(()=>validateFinalCandidateProof({...proof,sourceHash:"wrong"},inputs,bindings),/stale/,"Aggregate source digest must equal the exact bound source files");
  const missingSourceHash = {...proof}; delete (missingSourceHash as any).sourceHash;
  assert.throws(()=>validateFinalCandidateProof(missingSourceHash,inputs,bindings),/stale/,"Missing aggregate source digest cannot be accepted silently");
  assert.throws(()=>validateFinalCandidateProof({...proof,bindings:{...bindings,candidateMapSHA256:"c".repeat(64)}},inputs,bindings),/stale/);
  assert.throws(()=>validateFinalCandidateProof({...proof,executions:proof.executions.map(value=>({...value,agent:authors.draftAgent}))},inputs,bindings),/third/);
  assert.throws(()=>validateFinalCandidateProof({...proof,entries:alter(value=>{value.entries[0].intention="needs_review";value.entries[0].decision="needs_review";value.entries[0].coveredByIDs=[];}).entries},inputs,bindings),/held/);
  assert.equal((await ingestHelperJob(job,decisions,controlled,execution)).preserved,2,"Repeated valid intake cannot overwrite actual checkpoints");
} finally {await rm(directory,{recursive:true,force:true});}
console.log("Final candidate fixtures passed: complete source scopes, original/alias evidence, canonical peers, held coverage, third-author separation, stale proofs and immutable checkpoint retries. No database/provider calls.");
