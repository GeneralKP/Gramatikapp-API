// Read-only timing audit. Index setup is bypassed and every write is blocked.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { BSON, Collection, MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { generateToken, getUserFromToken } from '../src/features/auth/auth.service.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { loadCompactStudyQueue, loadCompactStudyCards, COMPACT_STUDY_SELECTION } from '../src/features/progress/studyTransport.js';
import { warmStudyCatalog } from '../src/features/progress/studyLoading.js';
import { isNewCard } from '../src/features/progress/newWordOrder.js';
import { combinedStudyCandidateFilter } from '../src/features/progress/studyCandidates.js';
const prototype = Collection.prototype as any;
for (const name of ['createIndex', 'dropIndex']) prototype[name] = async () => undefined;
for (const name of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'drop', 'createIndexes', 'dropIndexes']) {
  prototype[name] = async () => { throw new Error(`Read-only audit blocked ${name}`); };
}
let reads: Record<string, number> = {};
let commands: { name: string; collection?: string; stage?: string; elapsedMs: number; rows?: number; uncompressedBytes: number }[] = [];
const commandCollections = new Map<number, { collection: string; stage?: string }>();
const cursorStages = new Map<string, { collection: string; stage?: string }>();
function progressStage(filter: any, projection: any): string {
  if (filter?.$or?.some((branch: any) => branch.$or?.some((clause: any) => clause['scheduler.phase']))) return 'queue-and-counter-candidates';
  if (filter?.['card.sourceNoteGuid']) return 'new-word-siblings';
  if (filter?.isNew === true) return 'pending-new';
  if (filter?.$or?.some((clause: any) => clause.temporaryDueDate || clause.isNew)) return 'due-candidates';
  if (projection?.card || projection?.['card.prompt']) return 'selected-card-content';
  return 'progress-other';
}
// Capture only command names, durations and batch lengths, never filters/accounts/content.
const connect = MongoClient.prototype.connect;
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on('commandStarted', event => {
    if (!['find', 'getMore', 'aggregate'].includes(event.commandName)) return;
    const collection = event.command.find ?? event.command.aggregate ?? event.command.collection;
    if (typeof collection === 'string') {
      const info = event.commandName === 'getMore' ? cursorStages.get(String(event.command.getMore)) : undefined;
      commandCollections.set(event.requestId, info ?? { collection, ...(collection === 'userprogresses' ? { stage: progressStage(event.command.filter, event.command.projection) } : {}) });
    }
  });
  this.on('commandSucceeded', event => {
    if (!['find', 'getMore', 'aggregate'].includes(event.commandName)) return;
    const batch = event.reply.cursor?.firstBatch ?? event.reply.cursor?.nextBatch;
    const info = commandCollections.get(event.requestId);
    commands.push({ name: event.commandName, ...info, elapsedMs: Math.round(event.duration), rows: batch?.length, uncompressedBytes: BSON.calculateObjectSize(event.reply) });
    if (info && event.reply.cursor?.id && String(event.reply.cursor.id) !== '0') cursorStages.set(String(event.reply.cursor.id), info);
    commandCollections.delete(event.requestId);
  });
  return connect.call(this);
};
for (const name of ['find', 'findOne', 'aggregate', 'countDocuments']) {
  const original = prototype[name];
  prototype[name] = function (...args: any[]) {
    const key = `${this.collectionName}.${name}`;
    reads[key] = (reads[key] ?? 0) + 1;
    const result = original.apply(this, args);
    if (name === 'find' && process.env.AUDIT_BATCH_SIZE) result.batchSize(Number(process.env.AUDIT_BATCH_SIZE));
    return result;
  };
}
const db = await connectDatabase();
try {
  const [largest] = await db.progress.aggregate([{ $group: { _id: '$userId', cards: { $sum: 1 } } }, { $sort: { cards: -1 } }, { $limit: 1 }]).toArray();
  assert.ok(largest, 'Audit needs an existing study account');
  const user = await db.users.findOne({ _id: largest._id });
  assert.ok(user);
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const due = JSON.parse(readFileSync(new URL('./fixtures/loading-queries.json', import.meta.url), 'utf8')).DUE_ITEMS_QUERY;
  const dashboard = 'query AuditDashboard($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review total learned} learningPath(userId:$userId){id name level isUnlocked wordsTotal wordsLearned phrasesTotal phrasesLearned}}';
  if(process.env.AUDIT_COMPACT){
    await warmStudyCatalog(); // Match the production startup's static catalog warm-up.
    for(const [operation,itemType,cardLimit] of [
      ['compact-words-full','WORD',undefined],['compact-words-starter','WORD',24],
      ['compact-phrases-full','PHRASE',undefined],['compact-phrases-starter','PHRASE',24],
      ['compact-mixed-full',undefined,undefined],['compact-mixed-starter',undefined,24],
    ] as const){
      if(process.env.AUDIT_FILTER && !operation.includes(process.env.AUDIT_FILTER))continue;
      for(let run=0;run<Math.max(1,Number(process.env.AUDIT_REPEAT??1));run++){
        reads={};commands=[];const started=performance.now(),cpuStarted=process.cpuUsage();
        const newLimit=Number(process.env.AUDIT_NEW_LIMIT??0);
        assert.ok(Number.isInteger(newLimit) && newLimit>=0 && newLimit<=1000, 'AUDIT_NEW_LIMIT must be an integer from 0 to 1000');
        const input={itemType,...(cardLimit===undefined?{}:{cardLimit}),dueLimit:5000,newLimit,...(process.env.AUDIT_INCLUDE_COUNTS?{includeCounts:true}:{})};
        const result=await loadCompactStudyQueue(user,input);
        const cpu=process.cpuUsage(cpuStarted),elapsedMs=Math.round(performance.now()-started),operationReads={...reads},operationCommands=[...commands];
        if(process.env.AUDIT_VERIFY_COMBINED && input.includeCounts){
          const plain=await loadCompactStudyQueue(user,{...input,includeCounts:false});
          const {counts,...packet}=result;
          assert.ok(JSON.stringify(packet)===JSON.stringify(plain),'combined queue order/content/state must match the original compact queue');
          const separate=await (resolvers.Query.studyQueueCounts as any)(null,{userId:String(user._id),itemType},{user});
          assert.deepEqual(counts,{new:separate.new,learning:separate.learning,review:separate.review},'combined counters must match the original GraphQL calculation');
        }
        console.log(JSON.stringify({name:`${operation}-${run+1}`,elapsedMs,cpuMs:Math.round((cpu.user+cpu.system)/1000),accountCards:largest.cards,returnedCards:result.items.length,manifestCards:result.manifest.length,responseBytes:Buffer.byteLength(JSON.stringify(result)),reads:operationReads,databaseCommands:operationCommands.length,getMoreCommands:operationCommands.filter(command=>command.name==='getMore').length,...(process.env.AUDIT_VERIFY_COMBINED && input.includeCounts?{combinedVerified:true}:{}),...(process.env.AUDIT_DETAILS?{commands:operationCommands}:{})}));
        if(operation.endsWith('starter') && run===0 && result.remaining){
          reads={};commands=[];const chunkStarted=performance.now();
          const chunk=await loadCompactStudyCards(user,{itemIds:result.manifest.slice(result.items.length,result.items.length+100).map(row=>row.id)});
          console.log(JSON.stringify({name:`${operation}-background100`,elapsedMs:Math.round(performance.now()-chunkStarted),returnedCards:chunk.items.length,responseBytes:Buffer.byteLength(JSON.stringify(chunk)),databaseCommands:commands.length,...(process.env.AUDIT_DETAILS?{commands}:{})}));
        }
      }
    }
  }
  for (const [operation, source, variables] of [
    ['dashboard-cold', dashboard, {}], ['dashboard-warm', dashboard, {}],
    ['words-50', due, { itemType: 'WORD', dueLimit: 50, newLimit: 0 }],
    ['words-1000', due, { itemType: 'WORD', dueLimit: 1000, newLimit: 0 }],
    ['phrases', due, { itemType: 'PHRASE', dueLimit: 5000, newLimit: 0 }],
    ['phrases-entry', due, { itemType: 'PHRASE', dueLimit: 5000, newLimit: 20 }],
    ['phrases-counts', 'query AuditPhraseCounts($userId:ID!){studyQueueCounts(userId:$userId,itemType:"PHRASE"){new learning review total learned}}', {}],
    ['mixed', due, { dueLimit: 5000, newLimit: 0 }],
    ['phrases-category', due, { itemType: 'PHRASE', context: 'general_vocabulary', dueLimit: 5000, newLimit: 0 }],
    ['mixed-category', due, { context: 'general_vocabulary', dueLimit: 5000, newLimit: 0 }],
    ['authentication-me', 'query {me{id email authProvider createdAt settings{soundEnabled selectSound successSound errorSound popSound darkMode dailyNewCards}}}', {}],
  ] as const) {
    if (process.env.AUDIT_COMPACT || process.env.AUDIT_FILTER && !operation.includes(process.env.AUDIT_FILTER)) continue;
    for (let run = 0; run < Math.max(1, Number(process.env.AUDIT_REPEAT ?? 1)); run++) {
    const name = process.env.AUDIT_REPEAT ? `${operation}-${run + 1}` : operation;
    reads = {};
    commands = [];
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const authenticated = name.startsWith('authentication') ? await getUserFromToken(generateToken(user)) : user;
    const result = await graphql({ schema, source, variableValues: { userId: String(user._id), ...variables }, contextValue: { user: authenticated } });
    assert.equal(result.errors, undefined, result.errors?.map(error => error.message).join('; '));
    const elapsedMs = Math.round(performance.now() - started);
    const cpu = process.cpuUsage(cpuStarted);
    console.log(JSON.stringify({ name, elapsedMs, cpuMs: Math.round((cpu.user + cpu.system) / 1000), accountCards: largest.cards, returnedCards: (result.data?.dueItems as any[])?.length, responseBytes: Buffer.byteLength(JSON.stringify(result.data)), reads, databaseCommands: commands.length, getMoreCommands: commands.filter(command => command.name === 'getMore').length, ...(process.env.AUDIT_DETAILS ? { commands } : {}) }));
    if (process.env.AUDIT_MAX_MS) assert.ok(elapsedMs <= Number(process.env.AUDIT_MAX_MS), `${name} took ${elapsedMs}ms`);
    }
  }
  const now = new Date();
  const dueFilter={userId:user._id,suspended:{$ne:true},supersededByAnki:{$ne:true},$or:[{temporaryDueDate:{$lte:now}},{temporaryDueDate:null,nextDueDate:{$lte:new Date(now.getTime()+1200000)}},{isNew:true}]};
  const counterFilter={userId:user._id,$or:[{nextDueDate:{$lte:now}},{temporaryDueDate:{$lte:now}},{'scheduler.phase':{$in:['NEW','LEARNING','RELEARNING']}},{scheduler:null}]};
  const phraseIds=(await db.relationsPhrasesEsDe.find({}).project({_id:1}).toArray()).map(relation=>relation._id);
  const siblingInput=await db.progress.find({...dueFilter,itemType:'WORD'}).project<any>({itemId:1,isNew:1,'scheduler.phase':1,'card.sourceNoteGuid':1}).batchSize(5000).toArray();
  const siblingFilter={userId:user._id,itemType:'WORD','card.sourceNoteGuid':{$in:[...new Set(siblingInput.filter(isNewCard).filter(row=>row.card).map(row=>row.card.sourceNoteGuid))]},supersededByAnki:{$ne:true}};
  const siblingGuids=new Set(siblingFilter['card.sourceNoteGuid'].$in);
  for(const [name,collection,filter,projection,limit] of [
    ['words-query-plan',db.progress,{...dueFilter,itemType:'WORD'}],
    ['phrases-query-plan',db.progress,{...dueFilter,itemType:'PHRASE'}],
    ['mixed-query-plan',db.progress,dueFilter],
    ['word-combined-query-plan',db.progress,combinedStudyCandidateFilter(user._id,'WORD',now),COMPACT_STUDY_SELECTION],
    ['phrase-combined-query-plan',db.progress,combinedStudyCandidateFilter(user._id,'PHRASE',now),COMPACT_STUDY_SELECTION],
    ['mixed-combined-query-plan',db.progress,combinedStudyCandidateFilter(user._id,undefined,now),COMPACT_STUDY_SELECTION],
    ['word-sibling-full-query-plan',db.progress,siblingFilter,COMPACT_STUDY_SELECTION],
    ['word-sibling-missing-query-plan',db.progress,{...siblingFilter,itemId:{$nin:siblingInput.filter(row=>row.card && siblingGuids.has(row.card.sourceNoteGuid)).map(row=>row.itemId)}},COMPACT_STUDY_SELECTION,2],
    ['word-counter-query-plan',db.progress,{...counterFilter,itemType:'WORD'}],
    ['phrase-counter-query-plan',db.progress,{...counterFilter,itemType:'PHRASE'}],
    ['phrase-identity-query-plan',db.progress,{userId:user._id,$or:[{relationId:{$in:phraseIds}},{relationId:null,itemId:{$in:phraseIds}}]}],
    ['auth-id-query-plan',db.users,{_id:user._id}],
    ['login-email-query-plan',db.users,{email:user.email}],
    ['word-category-query-plan',db.wordsES,{contexts:'general_vocabulary'}],
    ['phrase-category-query-plan',db.phrasesES,{contexts:'general_vocabulary'}],
  ] as const) {
    const cursor=(collection as Collection).find(filter).project(projection??{_id:1});
    const plan=await (limit?cursor.limit(limit):cursor).explain('executionStats');
    const indexes=new Set<string>();
    const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(value.indexName)indexes.add(value.indexName);for(const child of Object.values(value))visit(child);};
    visit(plan.queryPlanner?.winningPlan);
    console.log(JSON.stringify({name,indexes:[...indexes],examinedKeys:plan.executionStats?.totalKeysExamined,examinedDocuments:plan.executionStats?.totalDocsExamined,returnedDocuments:plan.executionStats?.nReturned,executionMs:plan.executionStats?.executionTimeMillis}));
  }
} finally { await closeDatabase(); }
