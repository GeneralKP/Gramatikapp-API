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
const prototype = Collection.prototype as any;
for (const name of ['createIndex', 'dropIndex']) prototype[name] = async () => undefined;
for (const name of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'drop', 'createIndexes', 'dropIndexes']) {
  prototype[name] = async () => { throw new Error(`Read-only audit blocked ${name}`); };
}
let reads: Record<string, number> = {};
let commands: { name: string; collection?: string; elapsedMs: number; rows?: number; uncompressedBytes: number }[] = [];
const commandCollections = new Map<number, string>();
// Capture only command names, durations and batch lengths, never filters/accounts/content.
const connect = MongoClient.prototype.connect;
MongoClient.prototype.connect = async function () {
  this.monitorCommands = true;
  this.on('commandStarted', event => {
    if (!['find', 'getMore', 'aggregate'].includes(event.commandName)) return;
    const collection = event.command.find ?? event.command.aggregate ?? event.command.collection;
    if (typeof collection === 'string') commandCollections.set(event.requestId, collection);
  });
  this.on('commandSucceeded', event => {
    if (!['find', 'getMore', 'aggregate'].includes(event.commandName)) return;
    const batch = event.reply.cursor?.firstBatch ?? event.reply.cursor?.nextBatch;
    commands.push({ name: event.commandName, collection: commandCollections.get(event.requestId), elapsedMs: Math.round(event.duration), rows: batch?.length, uncompressedBytes: BSON.calculateObjectSize(event.reply) });
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
    if (process.env.AUDIT_FILTER && !operation.includes(process.env.AUDIT_FILTER)) continue;
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
  for(const [name,collection,filter] of [
    ['words-query-plan',db.progress,{...dueFilter,itemType:'WORD'}],
    ['phrases-query-plan',db.progress,{...dueFilter,itemType:'PHRASE'}],
    ['mixed-query-plan',db.progress,dueFilter],
    ['word-counter-query-plan',db.progress,{...counterFilter,itemType:'WORD'}],
    ['phrase-counter-query-plan',db.progress,{...counterFilter,itemType:'PHRASE'}],
    ['phrase-identity-query-plan',db.progress,{userId:user._id,$or:[{relationId:{$in:phraseIds}},{relationId:null,itemId:{$in:phraseIds}}]}],
    ['auth-id-query-plan',db.users,{_id:user._id}],
    ['login-email-query-plan',db.users,{email:user.email}],
    ['word-category-query-plan',db.wordsES,{contexts:'general_vocabulary'}],
    ['phrase-category-query-plan',db.phrasesES,{contexts:'general_vocabulary'}],
  ] as const) {
    const plan=await (collection as Collection).find(filter).project({_id:1}).explain('executionStats');
    const indexes=new Set<string>();
    const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(value.indexName)indexes.add(value.indexName);for(const child of Object.values(value))visit(child);};
    visit(plan.queryPlanner?.winningPlan);
    console.log(JSON.stringify({name,indexes:[...indexes],examinedKeys:plan.executionStats?.totalKeysExamined,examinedDocuments:plan.executionStats?.totalDocsExamined,returnedDocuments:plan.executionStats?.nReturned,executionMs:plan.executionStats?.executionTimeMillis}));
  }
} finally { await closeDatabase(); }
