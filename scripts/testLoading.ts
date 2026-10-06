import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase, getDb } from '../src/lib/database.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { withScheduler } from '../src/features/progress/reviews.js';
import { insertNewProgress } from '../src/features/progress/studyLoading.js';
import { invalidateStudyCatalog } from '../src/features/progress/catalogSummaryCache.js';
import { loadCompactStudyQueue, loadCompactStudyCards, loadCompactStudyMore } from '../src/features/progress/studyTransport.js';
import { studyTransportRouter } from '../src/features/progress/studyTransport.http.js';
import { scheduleStudyReview } from '../src/features/progress/studyScheduling.js';

// This suite never opens a network connection. It runs the real GraphQL schema,
// queue selection and nested resolvers against deterministic MongoDB responses.
const RealDate = Date;
const now = new RealDate('2026-10-06T10:00:00Z');
(globalThis as any).Date = class extends RealDate {
  constructor(value?: any) { super(value === undefined ? now.getTime() : value); }
  static now() { return now.getTime(); }
};
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const owner = id(1), otherOwner = id(2);
const word = (n: number, text: string) => ({_id:id(n),word:text,gramaticalCategories:['NOUN'],examples:[`${text} example`],contexts:['university'],level:'A1',cefrLevel:'A1.2',notes:'note',forms:{gender:n===11?'das':null,plural:'plural',past:null,perfect:null,imperativ:null,irregularConjugations:null,gramaticalCase:null},createdAt:now});
const phrase = (n: number, text: string) => ({_id:id(n),phrase:text,synonyms:['alternative'],contexts:['university'],level:'A1',cefrLevel:'A1.2',createdAt:now});
const user = {_id:owner,email:'fixture@example.invalid',settings:{dailyNewCards:20}};
const profile = {_id:owner,defaultOptions:{...DEFAULT_OPTIONS,reviewsPerDay:1000},timeZone:'Europe/Berlin',rollover:4};
const progress = (n:number,type='WORD',relation=20,extra:any={}) => {
 const p:any={_id:id(100+n),userId:owner,itemId:id(200+n),relationId:id(relation),itemType:type,isNew:false,ease:2.5,interval:30,repetitions:4,totalReviews:5,lapses:1,failureIndex:2,nextDueDate:new Date('2026-10-05T10:00:00Z'),lastReviewed:new Date('2026-09-05T10:00:00Z'),createdAt:new Date('2026-08-01T10:00:00Z'),scheduleVersion:3,...extra};
 p.scheduler=initialScheduler(p,profile.defaultOptions);return p;
};
const fixture:any={
 users:[user],schedulerprofiles:[profile],reviewevents:[],
 WORDS_ES:[word(10,'casa')],WORDS_DE:[word(11,'Haus')],
 WORDS_ES_DE:[{_id:id(20),main:id(10),translated:id(11),createdAt:now},{_id:id(21),main:id(10),translated:id(99),createdAt:now}],
 PHRASES_ES:[phrase(30,'Hoy aprendo alemán.')],PHRASES_DE:[phrase(31,'Ich lerne heute Deutsch.')],
 PHRASES_ES_DE:[{_id:id(40),main:id(30),translated:id(31),createdAt:now}],
 userprogresses:[progress(1,'WORD',20,{card:{source:'ANKI',sourceCardId:'1',sourceNoteGuid:'house',direction:'ES_DE',prompt:'casa',answer:'das Haus',acceptedAnswers:['das Haus'],notes:'note',examples:['Das Haus ist groß.'],deck:'App',tags:['NOUN']}}),progress(2,'WORD',20,{card:{source:'ANKI',sourceCardId:'2',sourceNoteGuid:'house',direction:'DE_ES',prompt:'das Haus',answer:'casa',acceptedAnswers:['casa'],notes:'note',examples:['Das Haus ist groß.'],deck:'App',tags:['NOUN']}}),progress(3,'WORD',90),progress(4,'WORD',21),progress(5,'PHRASE',40),progress(6,'WORD',20,{nextDueDate:new Date('2026-10-09T10:00:00Z')}),progress(7,'WORD',20,{userId:otherOwner})],
};
let reads:Record<string,number>={};
let progressQueries: { query: any; projection?: any; batchSize?: number; limit?: number }[] = [];
let counterCatalogQueries: { name: string; trace: { query: any; projection?: any; batchSize?: number; limit?: number } }[] = [];
let batches:any[]=[];
let holdRead: ((name: string, method: string, query: any) => Promise<void>) | undefined;
const valueAt=(doc:any,key:string)=>key.split('.').reduce((value,part)=>value?.[part],doc);
const equal=(a:any,b:any)=>a instanceof ObjectId||b instanceof ObjectId?String(a)===String(b):a instanceof RealDate||b instanceof RealDate?Number(a)===Number(b):a===b;
function matches(doc:any,query:any):boolean {
 return Object.entries(query).every(([key,condition]:[string,any])=>{
  if(key==='$or')return condition.some((q:any)=>matches(doc,q));
  if(key==='$and')return condition.every((q:any)=>matches(doc,q));
  const value=valueAt(doc,key);
  if(condition===null)return value==null;
  if(condition && typeof condition==='object' && !(condition instanceof ObjectId) && !(condition instanceof RealDate))return Object.entries(condition).every(([op,wanted]:[string,any])=>{
   if(op==='$in')return wanted.some((x:any)=>equal(value,x));
   if(op==='$nin')return !wanted.some((x:any)=>equal(value,x));
   if(op==='$ne')return !equal(value,wanted);
   if(op==='$exists')return (value!==undefined)===wanted;
   if(op==='$lte')return value!=null && value<=wanted;
   if(op==='$gt')return value!=null && value>wanted;
   throw new Error(`Unsupported fixture operator ${op}`);
  });
  return Array.isArray(value)?value.some(x=>equal(x,condition)):equal(value,condition);
 });
}
function project(doc:any,fields:any) {
 const result:any={};
 for(const [key,include] of Object.entries(fields))if(include && valueAt(doc,key)!==undefined){
  const parts=key.split('.');let target=result;
  for(const part of parts.slice(0,-1))target=target[part]??={};
  target[parts.at(-1)!]=valueAt(doc,key);
 }
 return result;
}
const collections=new Map();
function collection(name:string):any {
 if(collections.has(name))return collections.get(name);
 const count=(method:string)=>{reads[`${name}.${method}`]=(reads[`${name}.${method}`]??0)+1;};
 const result={
  async createIndex(){},async dropIndex(){},
  async insertOne(doc:any){fixture[name]??=[];fixture[name].push(doc);return {insertedId:doc._id};},
  find(query:any={}){count('find');const traced={query,projection:undefined as any,batchSize:undefined as number|undefined,limit:undefined as number|undefined};if(name==='userprogresses')progressQueries.push(traced);if(['WORDS_ES','WORDS_DE'].includes(name))counterCatalogQueries.push({name,trace:traced});let rows=(fixture[name]??[]).filter((doc:any)=>matches(doc,query));return {
   project(fields:any){traced.projection=fields;rows=rows.map((row:any)=>project(row,fields));return this;},
   batchSize(size:number){traced.batchSize=size;return this;},
   sort(fields:any){const [key,direction]=Object.entries(fields)[0] as [string,number];rows.sort((a:any,b:any)=>(valueAt(a,key)>valueAt(b,key)?1:valueAt(a,key)<valueAt(b,key)?-1:0)*direction);return this;},
   limit(size:number){traced.limit=size;if(size)rows=rows.slice(0,size);return this;},
   async toArray(){await holdRead?.(name,'find',query);return rows;},
  };},
  async findOne(query:any,options:any={}){count('findOne');await holdRead?.(name,'findOne',query);const row=(fixture[name]??[]).find((doc:any)=>matches(doc,query));return row ? options.projection ? project(row,options.projection):row : null;},
  async bulkWrite(operations:any[],options:any){
   assert.equal(name,'userprogresses');assert.deepEqual(options,{ordered:false});batches.push(operations);
   for(const {updateOne} of operations){
    assert.equal(updateOne.upsert,true);assert.deepEqual(Object.keys(updateOne.update),['$setOnInsert']);
    if(!fixture[name].some((doc:any)=>matches(doc,updateOne.filter)))fixture[name].push(updateOne.update.$setOnInsert);
   }
  },
  async updateOne(query:any,update:any,options:any={}){
   assert.equal(name,'userprogresses');let row=fixture[name].find((doc:any)=>matches(doc,query));
   if(!row && options.upsert){row={...query,...update.$setOnInsert};fixture[name].push(row);}
   if(row && update.$set)Object.assign(row,update.$set);
  },
  aggregate(){count('aggregate');assert.equal(name,'reviewevents');return {async toArray(){return [];}};},
 };
 collections.set(name,result);return result;
}
MongoClient.prototype.connect=async function(){return this;};
MongoClient.prototype.db=function(){return {collection} as any;};
MongoClient.prototype.startSession=function(){return {async withTransaction(work:any){return work();},async endSession(){}} as any;};
await connectDatabase();
// Versioned client operations keep this API-only CI suite independent of the web checkout.
const queries=JSON.parse(readFileSync(new URL('./fixtures/loading-queries.json',import.meta.url),'utf8'));
const query=(name:string)=>queries[name];
const dashboard='query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review total learned} learningPath(userId:$userId){id name level isUnlocked wordsTotal wordsLearned phrasesTotal phrasesLearned}}';
try {
 const schema=makeExecutableSchema({typeDefs,resolvers});
 const responses:any={};
 const execute=async(name:string,source:string,variables:any={})=>{
  invalidateStudyCatalog();
  reads={};counterCatalogQueries=[];
  const result=await graphql({schema,source,variableValues:{userId:String(owner),...variables},contextValue:{user}});
  if (result.errors) assert.ok(result.errors.every(error=>error.message==='Cannot return null for non-nullable field WordRelation.translated.'),result.errors.map(error=>error.message).join(';'));
  responses[name]=JSON.parse(JSON.stringify({data:result.data,...(result.errors?{errors:result.errors.map(error=>({message:error.message,path:error.path,locations:error.locations}))}:{})}));
  if(name==='due'){
   assert.equal(reads['WORDS_ES_DE.find'],1,'word relations must be fetched once for the entire queue');
   assert.equal(reads['WORDS_ES.find'],1);assert.equal(reads['WORDS_DE.find'],1);
   assert.equal(reads['PHRASES_ES_DE.find'],1);
   assert.equal(reads['WORDS_ES_DE.findOne']??0,0,'no per-card relation lookup');
   assert.equal(reads['WORDS_ES.findOne']??0,0,'no per-card word lookup, including missing endpoints');
  }
  if(name==='dashboard')assert.equal(reads['userprogresses.find'],2,'counts and learning path share compact identities plus one scoped counter snapshot');
  if(name==='phrases-counts'){
   assert.equal(reads['PHRASES_ES_DE.find'],1);
   for(const key of ['WORDS_ES_DE.find','WORDS_ES.find','PHRASES_ES.find'])assert.equal(reads[key]??0,0,'counts load only the selected relations and no unused catalog metadata');
  }
  if(name==='phrases-due'){
   assert.equal(reads['PHRASES_ES_DE.find'],1);assert.equal(reads['PHRASES_ES.find'],1);assert.equal(reads['PHRASES_DE.find'],1);
   assert.equal(reads['WORDS_ES_DE.find']??0,0);assert.equal(reads['schedulerprofiles.findOne'],1);
  }
 };
 await execute('dashboard',dashboard);
 // Cross-request catalog reuse must never reuse private account state. The
 // entire dashboard contract is checked again after changing live progress.
 reads={};
 const warmDashboard=await graphql({schema,source:dashboard,variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(warmDashboard.errors,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(warmDashboard.data)),responses.dashboard.data);
 for(const name of ['WORDS_ES_DE','PHRASES_ES_DE','WORDS_ES','PHRASES_ES'])assert.equal(reads[`${name}.find`]??0,0,'warm dashboards reuse immutable catalog summaries');
 assert.equal(reads['userprogresses.find'],2,'progress is fresh on every dashboard request');
 assert.equal(reads['schedulerprofiles.findOne'],1);assert.equal(reads['reviewevents.aggregate'],1);
 const savedProgress=fixture.userprogresses;
 fixture.userprogresses=savedProgress.map((p:any)=>({...p,repetitions:0}));
 const freshDashboard=await graphql({schema,source:dashboard,variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(freshDashboard.errors,undefined);
 const expectedFresh=JSON.parse(JSON.stringify(responses.dashboard.data));
 expectedFresh.studyQueueCounts.learned=0;
 for(const node of expectedFresh.learningPath){node.wordsLearned=0;node.phrasesLearned=0;}
 assert.deepEqual(JSON.parse(JSON.stringify(freshDashboard.data)),expectedFresh,'catalog caching never makes learned/mastery counters stale');
 fixture.userprogresses=savedProgress;
 const otherDashboard=await graphql({schema,source:dashboard,variableValues:{userId:String(otherOwner)},contextValue:{user:{...user,_id:otherOwner}}});
 assert.equal(otherDashboard.errors,undefined);
 const expectedOther=JSON.parse(JSON.stringify(responses.dashboard.data));
 expectedOther.studyQueueCounts={new:0,learning:0,review:1,total:2,learned:1};
 for(const node of expectedOther.learningPath){node.wordsLearned=1;node.phrasesLearned=0;}
 assert.deepEqual(JSON.parse(JSON.stringify(otherDashboard.data)),expectedOther,'shared catalogs never share progress or mastery between accounts');
 const relationCount=fixture.WORDS_ES_DE.length;
 const added=await graphql({schema,source:'mutation($main:ID!,$translated:ID!){addWordRelation(mainId:$main,translatedId:$translated){id}}',variableValues:{main:String(id(10)),translated:String(id(11))},contextValue:{user}});
 assert.equal(added.errors,undefined);reads={};
 const afterCatalogWrite=await graphql({schema,source:dashboard,variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(afterCatalogWrite.errors,undefined);
 assert.equal((afterCatalogWrite.data?.studyQueueCounts as any).total,relationCount+1,'own catalog mutations become visible immediately');
 assert.equal(reads['WORDS_ES_DE.find'],1,'catalog mutation invalidates the cached summary');
 const relationCollection=getDb().relationsWordsEsDe, insert=relationCollection.insertOne;
 relationCollection.insertOne=async function(doc:any){await insert.call(this,doc);throw new Error('fixture acknowledgement lost');};
 try {
  const uncertainWrite=await graphql({schema,source:'mutation($main:ID!,$translated:ID!){addWordRelation(mainId:$main,translatedId:$translated){id}}',variableValues:{main:String(id(10)),translated:String(id(11))},contextValue:{user}});
  assert.equal(uncertainWrite.errors?.[0]?.message,'fixture acknowledgement lost');reads={};
  const afterUncertainWrite=await graphql({schema,source:dashboard,variableValues:{userId:String(owner)},contextValue:{user}});
  assert.equal(afterUncertainWrite.errors,undefined);
  assert.equal((afterUncertainWrite.data?.studyQueueCounts as any).total,relationCount+2,'committed writes invalidate even when acknowledgement is lost');
  assert.equal(reads['WORDS_ES_DE.find'],1);
 } finally {relationCollection.insertOne=insert;}
 fixture.WORDS_ES_DE.splice(relationCount);invalidateStudyCatalog();
 console.log('PASS warm dashboard full contract, fresh account counters and immediate catalog-write invalidation');
 await execute('due',query('DUE_ITEMS_QUERY'),{dueLimit:5000,newLimit:0});
 await execute('more',query('STUDY_MORE_QUERY'),{limit:3,newLimit:0,itemType:'WORD'});
 await execute('category',query('DUE_ITEMS_QUERY'),{dueLimit:5000,newLimit:0,itemType:'WORD',context:'university'});
 const practiceResponses:any={};
 for(const [name,source,variables] of [
  ['phrases-due',query('DUE_ITEMS_QUERY'),{dueLimit:5000,newLimit:0,itemType:'PHRASE'}],
  ['mixed-category',query('DUE_ITEMS_QUERY'),{dueLimit:5000,newLimit:0,context:'university'}],
  ['phrases-counts','query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"PHRASE"){new learning review total learned}}',{}],
  ['mixed-counts','query($userId:ID!){studyQueueCounts(userId:$userId){new learning review total learned}}',{}],
 ] as const){
  await execute(name,source,variables);practiceResponses[name]=responses[name];delete responses[name];
 }
 const practiceFixture=new URL('./fixtures/practice-responses.json',import.meta.url);
 assert.deepEqual(practiceResponses,JSON.parse(readFileSync(practiceFixture,'utf8')),'Phrase/mixed response contracts must remain unchanged');
 reads={};
 progressQueries=[];
 const scopedCounts=await graphql({schema,source:'query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"PHRASE"){new learning review total learned}}',variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(scopedCounts.errors,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(scopedCounts.data)),practiceResponses['phrases-counts'].data);
 assert.ok(progressQueries.some(read=>read.query.itemType==='PHRASE'),'phrase counter scheduling reads must exclude unrelated word cards');
 assert.ok(progressQueries.some(read=>!read.query.itemType && !read.projection?.scheduler && !read.projection?.anki),'cross-type seen/mastery inputs use only compact identities');
 invalidateStudyCatalog();reads={};
 const aliases=await graphql({schema,source:'query($userId:ID!){first:studyQueueCounts(userId:$userId,itemType:"PHRASE",context:"University"){new learning review total learned} second:studyQueueCounts(userId:$userId,itemType:"PHRASE",context:"university"){new learning review total learned}}',variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(aliases.errors,undefined);
 const phraseCounts=practiceResponses['phrases-counts'].data.studyQueueCounts;
 assert.deepEqual(JSON.parse(JSON.stringify(aliases.data)),{first:phraseCounts,second:phraseCounts});
 assert.equal(reads['schedulerprofiles.findOne'],1);assert.equal(reads['userprogresses.find'],2);
 assert.equal(reads['reviewevents.aggregate'],1,'counter aliases share daily allowances within the request');
 assert.equal(reads['PHRASES_ES_DE.find'],2,'one category lookup and one catalog read shared by both aliases');
 assert.equal(reads['PHRASES_ES.find'],1);assert.equal(reads['PHRASES_DE.find'],1);
 assert.equal(reads['WORDS_ES_DE.find']??0,0,'phrase category counts do not fetch words');
 reads={};
 const zero=await graphql({schema,source:'query($userId:ID!){dueItems(userId:$userId,dueLimit:0,newLimit:0,context:"invalid?"){itemId}}',variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(zero.errors,undefined);assert.deepEqual(JSON.parse(JSON.stringify(zero.data)),{dueItems:[]});
 assert.equal(reads['WORDS_ES.find']??0,0,'an empty-limit request keeps the original early return before category lookup');
 const originalProgress=fixture.userprogresses;
 fixture.userprogresses=[progress(14,'WORD',20,{itemId:id(20),relationId:null}),progress(15,'WORD',20,{itemId:id(21),relationId:undefined})];
 await execute('legacy-category-counts','query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD",context:"university"){new learning review total learned}}');
 fixture.userprogresses=originalProgress;
 // Unseen native pairs and a single-place daily limit must stay read-only in counts.
 fixture.userprogresses=[];user.settings.dailyNewCards=1;
 await execute('native-new-count',dashboard);
 assert.equal(counterCatalogQueries.length,2);
 for(const {name,trace} of counterCatalogQueries){
  assert.deepEqual(trace.projection,name==='WORDS_ES'?{_id:1,word:1,contexts:1,level:1}:{_id:1,word:1,'forms.gender':1},'counter-only native pairs never download full notes/examples');
  assert.equal(trace.batchSize,5000,'complete native counter reads avoid extra cursor batches');
 }
 // A buried recognition sibling must block introduction of its typing card.
 const recognition=progress(8,'WORD',20,{isNew:true,interval:0,repetitions:0,lastReviewed:null,buriedUntil:new Date('2026-10-07T10:00:00Z'),card:{source:'ANKI',sourceCardId:'8',sourceNoteGuid:'paired',direction:'DE_ES',prompt:'Haus',answer:'casa',deck:'App'}});
 const production=progress(9,'WORD',20,{isNew:true,interval:0,repetitions:0,lastReviewed:null,card:{...recognition.card,sourceCardId:'9',direction:'ES_DE'}});
 fixture.userprogresses=[recognition,production];
 await execute('buried-prerequisite',dashboard);
 // Legacy app reviews must use live scheduling rather than the imported NEW state.
 const legacy=progress(11,'WORD',20,{anki:{type:0,queue:0,left:0,reps:5,due:1},updatedAt:now});
 delete legacy.scheduler;
 fixture.userprogresses=[legacy,progress(12,'WORD',20,{suspended:true}),progress(13,'WORD',20,{supersededByAnki:true})];
 await execute('legacy-scheduler',dashboard);
 fixture.schedulerprofiles=[];
 await execute('profile-absent',dashboard);
 await execute('profile-absent-cards',query('DUE_ITEMS_QUERY'),{dueLimit:5000,newLimit:0,itemType:'WORD'});
 const golden=new URL('./fixtures/loading-responses.json',import.meta.url);
 {
  assert.deepEqual(responses,JSON.parse(readFileSync(golden,'utf8')),'Complete GraphQL responses must match the pre-optimization baseline');
  // An explicitly absent profile must not trigger one database lookup per card.
  const unscheduled=progress(10);delete unscheduled.scheduler;reads={};
  await withScheduler(unscheduled,null);assert.equal(reads['schedulerprofiles.findOne']??0,0);
  console.log('PASS complete dashboard/due/more/category response shapes, missing relations/endpoints, native allowance, buried siblings, bulk reads and absent profiles');
 }
 // Counter projections must retain per-card limits and every prerequisite,
 // including cards whose ordinary review date is in the future.
 fixture.schedulerprofiles=[profile];user.settings.dailyNewCards=20;
 const counter=async(itemType='WORD')=>{
  invalidateStudyCatalog();
  const result=await graphql({schema,source:'query($userId:ID!,$itemType:String){studyQueueCounts(userId:$userId,itemType:$itemType){new learning review}}',variableValues:{userId:String(owner),itemType},contextValue:{user}});
  assert.equal(result.errors,undefined);
  return JSON.parse(JSON.stringify(result.data)).studyQueueCounts;
 };
 const futureRecognition={...recognition,buriedUntil:null,nextDueDate:new Date('2026-10-09T10:00:00Z')};
 fixture.userprogresses=[futureRecognition,production];
 assert.deepEqual(await counter(),{new:2,learning:0,review:0},'future NEW recognition must remain before production');
 fixture.userprogresses=[{...futureRecognition,suspended:true},production];
 assert.deepEqual(await counter(),{new:0,learning:0,review:0},'suspended recognition must still block its production sibling');
 fixture.userprogresses=[{...futureRecognition,buriedUntil:new Date('2026-10-07T10:00:00Z')},production];
 assert.deepEqual(await counter(),{new:0,learning:0,review:0},'buried future recognition remains a prerequisite');
 fixture.userprogresses=[{...futureRecognition,isNew:false,scheduler:{...futureRecognition.scheduler,phase:'REVIEW',queue:'DAY'}},production];
 assert.deepEqual(await counter(),{new:1,learning:0,review:0},'already learned future recognition permits new production');
 fixture.userprogresses=[futureRecognition,production].map(p=>({...p,scheduler:{...p.scheduler,options:{...p.scheduler.options,reviewsPerDay:0}}}));
 assert.deepEqual(await counter(),{new:0,learning:0,review:0},'per-card review ceilings must not fall back to the profile');
 const pendingPhrase=progress(70,'PHRASE',40,{isNew:true,interval:0,repetitions:0,lastReviewed:null,nextDueDate:new Date('2026-10-09T10:00:00Z')});
 pendingPhrase.scheduler.options={...pendingPhrase.scheduler.options,newPerDay:0};
 fixture.userprogresses=[pendingPhrase];
 assert.deepEqual(await counter('PHRASE'),{new:1,learning:0,review:0},'account daily allowance remains authoritative over embedded newPerDay');
 const aheadPhrase=progress(71,'PHRASE',40,{nextDueDate:new Date(now.getTime()+7200_000)});
 aheadPhrase.scheduler={...aheadPhrase.scheduler,phase:'LEARNING',queue:'MINUTE',options:{...aheadPhrase.scheduler.options,learnAheadSeconds:7200}};
 fixture.userprogresses=[aheadPhrase];
 assert.deepEqual(await counter('PHRASE'),{new:0,learning:1,review:0},'future minute learning retains customized learn-ahead boundary');
 fixture.userprogresses=[{...aheadPhrase,nextDueDate:new Date(now.getTime()+7200_001)}];
 assert.deepEqual(await counter('PHRASE'),{new:0,learning:0,review:0},'one millisecond beyond learn-ahead stays unavailable');
 fixture.userprogresses=[progress(72,'PHRASE',40,{nextDueDate:new Date('2026-10-09T10:00:00Z'),temporaryDueDate:new Date(now.getTime()-1000)})];
 assert.deepEqual(await counter('PHRASE'),{new:0,learning:0,review:1},'temporary due date keeps a future regular review visible');
 const legacyFuture={...pendingPhrase,anki:{type:0,queue:0,left:0,reps:0,due:1},isNew:false,totalReviews:0};delete legacyFuture.scheduler;
 fixture.userprogresses=[legacyFuture];
 assert.deepEqual(await counter('PHRASE'),{new:1,learning:0,review:0},'legacy future introductions still initialize their Anki scheduler');
 for(const relationId of [id(40),null,undefined]){
  fixture.userprogresses=[progress(73,'WORD',40,{itemId:id(40),relationId})];
  assert.deepEqual(await counter('PHRASE'),{new:0,learning:0,review:0},'catalog-scoped identities preserve cross-type IDs and null/missing fallbacks');
 }
 console.log('PASS future NEW prerequisites, buried/suspended siblings, customized review ceilings/learn-ahead, temporary reviews and cross-type legacy identities');
 // Real resolver ordering under held MongoDB reads proves independent work
 // overlaps; no elapsed-time threshold or live connection is needed.
 fixture.userprogresses=[progress(74,'PHRASE',40)];reads={};
 let releaseSnapshot!:()=>void, snapshotStarted!:()=>void;
 const snapshotGate=new Promise<void>(resolve=>{releaseSnapshot=resolve});
 const snapshotStart=new Promise<void>(resolve=>{snapshotStarted=resolve});
 holdRead=async(name,method,query)=>{if(name==='userprogresses' && method==='find' && query.itemType==='PHRASE'){snapshotStarted();await snapshotGate;}};
 const overlappingCounts=counter('PHRASE');
 await snapshotStart;await new Promise(resolve=>setImmediate(resolve));
 try {assert.equal(reads['reviewevents.aggregate'],1,'daily allowances start before the counter snapshot finishes');}
 finally {releaseSnapshot();holdRead=undefined;}
 await overlappingCounts;
 reads={};let releaseProfile!:()=>void, profileStarted!:()=>void;
 const profileGate=new Promise<void>(resolve=>{releaseProfile=resolve});
 const profileStart=new Promise<void>(resolve=>{profileStarted=resolve});
 holdRead=async(name,method)=>{if(name==='schedulerprofiles' && method==='findOne'){profileStarted();await profileGate;}};
 const overlappingDue=graphql({schema,source:query('DUE_ITEMS_QUERY'),variableValues:{userId:String(owner),itemType:'PHRASE',dueLimit:5000,newLimit:0},contextValue:{user}});
 await profileStart;await new Promise(resolve=>setImmediate(resolve));
 try {assert.equal(reads['userprogresses.find'],1,'due selection starts before scheduler-profile lookup finishes');}
 finally {releaseProfile();holdRead=undefined;}
 assert.equal((await overlappingDue).errors,undefined);
 console.log('PASS counters overlap daily allowance reads and initial queues overlap scheduler metadata');
 // Collection-local identifiers can overlap; relation type still controls which
 // GraphQL field is populated, even when both collections use the same ObjectId.
 fixture.userprogresses=[progress(21,'WORD',20),progress(22,'PHRASE',20)];
 fixture.PHRASES_ES_DE.push({_id:id(20),main:id(30),translated:id(31),createdAt:now});
 const collision=await graphql({schema,source:'query($userId:ID!){dueItems(userId:$userId,dueLimit:50,newLimit:0){itemType wordRelation{id} phraseRelation{id}}}',variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(collision.errors,undefined);
 const collisionRows=JSON.parse(JSON.stringify(collision.data)).dueItems;
 assert.equal(collisionRows.length,2);
 assert.deepEqual(collisionRows.find((p:any)=>p.itemType==='WORD'),{itemType:'WORD',wordRelation:{id:String(id(20))},phraseRelation:null});
 assert.deepEqual(collisionRows.find((p:any)=>p.itemType==='PHRASE'),{itemType:'PHRASE',wordRelation:null,phraseRelation:{id:String(id(20))}});
 fixture.PHRASES_ES_DE.pop();
 // Exercise actual allocation, then a repeat request, against the same mock store.
 // New phrases retain their original GraphQL dates/content and are written in one batch.
 fixture.schedulerprofiles=[profile];user.settings.dailyNewCards=20;fixture.userprogresses=[];batches=[];reads={};
 fixture.PHRASES_ES_DE.push({_id:id(41),main:id(30),translated:id(31),createdAt:now});
 const freshQuery='query($userId:ID!){dueItems(userId:$userId,itemType:"PHRASE",context:"university",dueLimit:0,newLimit:2){itemId itemType schedulerPhase ease interval repetitions failureIndex nextDueDate lastReviewed phraseRelation{id main{id phrase synonyms contexts level} translated{id phrase synonyms contexts level}}}}';
 const fresh=await graphql({schema,source:freshQuery,variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(fresh.errors,undefined);
 const expected=[40,41].map(n=>({itemId:String(id(n)),itemType:'PHRASE',schedulerPhase:'NEW',ease:2.5,interval:0,repetitions:0,failureIndex:0,nextDueDate:now.toISOString(),lastReviewed:null,phraseRelation:{id:String(id(n)),main:{id:String(id(30)),phrase:'Hoy aprendo alemán.',synonyms:['alternative'],contexts:['university'],level:'A1'},translated:{id:String(id(31)),phrase:'Ich lerne heute Deutsch.',synonyms:['alternative'],contexts:['university'],level:'A1'}}}));
 assert.deepEqual(JSON.parse(JSON.stringify(fresh.data)),{dueItems:expected});
 assert.equal(batches.length,1,'one batch for the new-card allocation');assert.equal(batches[0].length,2);
 assert.equal(reads['PHRASES_ES_DE.find'],3,'category selection is reused by allocation, followed by catalog hydration');
 assert.equal(reads['WORDS_ES_DE.find']??0,0);
 reads={};const repeated=await graphql({schema,source:freshQuery,variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(repeated.errors,undefined);assert.deepEqual(JSON.parse(JSON.stringify(repeated.data)),{dueItems:expected});
 assert.equal(batches.length,1,'existing new cards never get inserted or reset again');
 assert.equal(reads['userprogresses.find'],1,'phrase entry reuses its full pending queue and avoids both pending and all-reviewed rereads');
 const originalDates=fixture.userprogresses.map((p:any)=>p.nextDueDate);
 await insertNewProgress(fixture.userprogresses.map((p:any)=>({...p,nextDueDate:new Date('2030-01-01')})),getDb());
 assert.deepEqual(fixture.userprogresses.map((p:any)=>p.nextDueDate),originalDates,'upserts do not overwrite schedules');
 const failingDb=(error:any)=>({progress:{async bulkWrite(){throw error;}}}) as any;
 await insertNewProgress([],failingDb(new Error('empty must not write')));
 await insertNewProgress(fixture.userprogresses,failingDb({code:11000,writeErrors:[{code:11000}]}));
 for(const error of [new Error('connection lost'),{code:121},{code:11000,writeErrors:[{code:11000},{code:121}]},{code:11000,writeConcernErrors:[{code:64}]},{code:11000,result:{getWriteConcernError:()=>({code:64})}}]){
  await assert.rejects(insertNewProgress(fixture.userprogresses,failingDb(error)),actual=>actual===error,'only concurrent duplicate-key conflicts may be ignored');
 }
 console.log('PASS exact new-phrase responses, repeat allocation, scoped/reused categories, pending-queue short circuit, batched idempotent upserts and error propagation');
 // A fresh pending read remains necessary for concurrent devices, but covered
 // IDs cannot change the outer queue because its merge discards duplicates.
 // Keep the later sibling lookup fresh instead of caching its earlier result.
 const pendingCard=(n:number,guid:string,direction:string,extra:any={})=>progress(n,'WORD',20,{isNew:true,interval:0,repetitions:0,totalReviews:0,lapses:0,lastReviewed:null,
  card:{source:'ANKI',sourceCardId:String(n),sourceNoteGuid:guid,direction,prompt:'prompt',answer:'answer',acceptedAnswers:['answer'],notes:'note',examples:['example'],deck:'App'},...extra});
 const pendingPair=[pendingCard(61,'pending-pair','DE_ES'),pendingCard(62,'pending-pair','ES_DE')];
 const siblingReads=()=>progressQueries.filter(read=>read.query['card.sourceNoteGuid']).length;
 const pendingArgs={dueLimit:5000,newLimit:2,itemType:'WORD'};
 for(const [label,rows,newLimit,dailyLimit,expected] of [
  ['complete pair',pendingPair,2,20,[61,62]],
  ['whole-pair overflow',pendingPair,1,20,[]],
  ['last odd allowance',pendingPair,1,1,[61]],
  ['suspended recognition',[{...pendingPair[0],suspended:true},pendingPair[1]],1,20,[]],
  ['buried recognition',[{...pendingPair[0],buriedUntil:new Date(now.getTime()+3600000)},pendingPair[1]],1,20,[]],
  ['future recognition',[{...pendingPair[0],nextDueDate:new Date(now.getTime()+86400000)},pendingPair[1]],2,20,[61,62]],
  ['duplicate directions',[...pendingPair,pendingCard(63,'pending-pair','DE_ES')],2,20,[61,62]],
  ['null relations',pendingPair.map(p=>({...p,relationId:null})),2,20,[61,62]],
  ['absent relations',pendingPair.map(p=>({...p,relationId:undefined})),2,20,[61,62]],
 ] as const){
  fixture.userprogresses=rows;user.settings.dailyNewCards=dailyLimit;progressQueries=[];batches=[];
  const packet=await loadCompactStudyQueue(user as any,{...pendingArgs,newLimit});
  assert.deepEqual(packet.items.map(row=>row.id),expected.map(n=>String(id(200+n))),label);
  assert.equal(siblingReads(),1,`${label}: covered pending work must leave one fresh outer sibling lookup`);
  assert.equal(batches.length,0,`${label}: candidate count, not eligible group count, prevents allocation`);
  const pendingReads=progressQueries.filter(read=>read.query.isNew===true);
  assert.equal(pendingReads.length,1,`${label}: covered pending IDs need one identity read`);
  assert.deepEqual(pendingReads[0].projection,{_id:0,itemId:1,itemType:1,relationId:1,'card.sourceCardId':1,'card.sourceNoteGuid':1,'card.direction':1},'covered reads never transfer scheduler state, options or card content');
  assert.equal(pendingReads[0].batchSize,5000,'the identity scout remains bounded without limiting the queue');
  const siblingRead=progressQueries.find(read=>read.query['card.sourceNoteGuid'])!;
  assert.ok(siblingRead.query.itemId?.$nin?.length,'already loaded sibling IDs are excluded at the database');
  assert.equal(siblingRead.limit,2,'the prerequisite scout detects ambiguous missing-card order with two rows');
 }
 user.settings.dailyNewCards=20;
 fixture.userprogresses=[...pendingPair];progressQueries=[];
 let pendingInserted=false;
 holdRead=async(name,method,query)=>{
  if(!pendingInserted && name==='userprogresses' && method==='find' && query.$or?.some((clause:any)=>clause.temporaryDueDate)){
   pendingInserted=true;fixture.userprogresses.push(pendingCard(64,'arrived-pair','DE_ES'),pendingCard(65,'arrived-pair','ES_DE'));
  }
 };
 try{
  const packet=await loadCompactStudyQueue(user as any,{...pendingArgs,newLimit:4});
  assert.deepEqual(packet.items.map(row=>row.id),[61,62,64,65].map(n=>String(id(200+n))),'pending IDs arriving after the initial snapshot are retained');
  assert.equal(siblingReads(),2,'unseen pending IDs keep both original prerequisite reads');
  const pendingReads=progressQueries.filter(read=>read.query.isNew===true);
  assert.equal(pendingReads.length,2,'unknown pending IDs require the full fresh fallback');
  assert.equal(pendingReads[1].projection.scheduler,1,'fallback restores every selection and scheduling input');
 }finally{holdRead=undefined;}
 fixture.userprogresses=[pendingPair[1]];progressQueries=[];let recognitionInserted=false;
 holdRead=async(name,method,query)=>{
  if(!recognitionInserted && name==='userprogresses' && method==='find' && query.isNew===true){
   recognitionInserted=true;fixture.userprogresses.push({...pendingPair[0],suspended:true});
  }
 };
 try{
  const packet=await loadCompactStudyQueue(user as any,{...pendingArgs,newLimit:1});
  assert.deepEqual(packet.items,[],'a late suspended recognition still blocks its unseen reverse');
  assert.equal(siblingReads(),1,'the remaining sibling lookup runs after the fresh pending read');
 }finally{holdRead=undefined;}
 // An unsorted sibling query can choose the first of duplicate directions.
 // If multiple missing records exist, retain the original query/order rather
 // than relying on a changed Mongo query plan to choose the same prerequisite.
 const suspendedReading={...pendingPair[0],suspended:true};
 const reviewedReading=pendingCard(66,'pending-pair','DE_ES',{isNew:false,nextDueDate:new Date(now.getTime()+86400000),interval:30,repetitions:4});
 for(const [rows,expected] of [[ [suspendedReading,reviewedReading,pendingPair[1]],[] ],[ [reviewedReading,suspendedReading,pendingPair[1]],[62] ]] as const){
  fixture.userprogresses=rows;progressQueries=[];
  const packet=await loadCompactStudyQueue(user as any,{...pendingArgs,newLimit:1});
  assert.deepEqual(packet.items.map(row=>row.id),expected.map(n=>String(id(200+n))),'duplicate missing recognition retains the original first-direction rule');
  const siblingQueries=progressQueries.filter(read=>read.query['card.sourceNoteGuid']);
  assert.equal(siblingQueries.length,2,'ambiguous missing records use the original fresh full sibling fallback');
  assert.equal(siblingQueries[0].limit,2);assert.ok(siblingQueries[0].query.itemId?.$nin);
  assert.equal(siblingQueries[1].query.itemId,undefined);assert.equal(siblingQueries[1].limit,undefined,'fallback must never cap queue completeness');
 }
 // The original duplicate-ID postfilter applies across item types, including
 // collection-local ID collisions; pushing it down must retain that contract.
 fixture.userprogresses=[progress(61,'PHRASE',40),pendingPair[1],{...pendingPair[0],isNew:false,nextDueDate:new Date(now.getTime()+86400000)}];progressQueries=[];
 const collidedPending=await loadCompactStudyQueue(user as any,{dueLimit:5000,newLimit:1});
 assert.deepEqual(collidedPending.items.map(row=>[row.id,row.type]),[[String(id(261)),'PHRASE'],[String(id(262)),'WORD']]);
 assert.ok(progressQueries.find(read=>read.query['card.sourceNoteGuid'])!.query.itemId.$nin.some((itemId:any)=>String(itemId)===String(id(262))),'only loaded matching-GUID identities need to enlarge the exclusion query; the final seen filter still handles cross-type collisions');
 const aheadReading=(n:number,guid:string)=>{const p=pendingCard(n,guid,'DE_ES',{isNew:false,nextDueDate:new Date(now.getTime()+2700000),interval:30,repetitions:4});p.scheduler={...p.scheduler,phase:'LEARNING',queue:'MINUTE',remainingSteps:1,options:{...p.scheduler.options,learnAheadSeconds:7200}};return p;};
 fixture.userprogresses=[aheadReading(67,'ahead-b'),aheadReading(68,'ahead-a'),pendingCard(69,'ahead-a','ES_DE'),pendingCard(70,'ahead-b','ES_DE')];
 const aheadOriginal=await resolvers.Query.dueItems(null,{userId:String(owner),...pendingArgs,includeLearningAhead:true},{user} as any);
 const aheadCompact=await loadCompactStudyQueue(user as any,pendingArgs);
 assert.deepEqual(aheadCompact.items.map(row=>row.id),aheadOriginal.map((row:any)=>row.itemId),'multiple missing learning-ahead siblings retain original order and completeness');
 for(const changedCard of [{...pendingPair[0].card,sourceCardId:'changed'}, {...pendingPair[0].card,sourceNoteGuid:'changed'}, {...pendingPair[0].card,direction:'ES_DE'},undefined]){
  fixture.userprogresses=[...pendingPair];progressQueries=[];let metadataChanged=false;
  holdRead=async(name,method,query)=>{
   if(!metadataChanged && name==='userprogresses' && method==='find' && query.$or?.some((clause:any)=>clause.temporaryDueDate)){
    metadataChanged=true;fixture.userprogresses[0]={...pendingPair[0],card:changedCard};
   }
  };
  try{
   await loadCompactStudyQueue(user as any,pendingArgs);
   const pendingReads=progressQueries.filter(read=>read.query.isNew===true);
   assert.equal(pendingReads.length,2,'changed directional identity/card presence disables the scout shortcut');
   assert.equal(pendingReads[1].projection.scheduler,1);
  }finally{holdRead=undefined;}
 }
 console.log('PASS covered pending shortcut, pair/odd/blocked/duplicate ordering, concurrent pending arrivals and fresh late recognition');
 // The compact transport must retain the real queue and every local transition,
 // while hydration can be restricted to a prefix independently of dueLimit.
 const ankiCard={source:'ANKI',sourceCardId:'901',sourceNoteGuid:'compact-pair',direction:'DE_ES',prompt:'das Haus',answer:'casa',acceptedAnswers:['casa'],notes:'reveal note',examples:['reveal example'],deck:'App',tags:['NOUN']};
 const compactCases=[
  progress(81,'WORD',20,{card:ankiCard}),
  progress(82,'WORD',20,{card:{...ankiCard,source:'APP',sourceCardId:'902',direction:'ES_DE',prompt:'casa',answer:'das Haus',acceptedAnswers:['das Haus']}}),
  progress(83,'WORD',20),
  progress(84,'PHRASE',40,{card:{...ankiCard,sourceNoteGuid:'cloze',direction:'CLOZE',prompt:'Ich […] heute Deutsch.',answer:'lerne',acceptedAnswers:['lerne']}}),
  progress(85,'PHRASE',40),
  progress(86,'WORD',90),
  progress(87,'WORD',21),
  progress(88,'PHRASE',40,{nextDueDate:new Date(now.getTime()+300_000)}),
  progress(89,'WORD',20,{nextDueDate:new Date('2026-10-09T10:00:00Z'),temporaryDueDate:new Date(now.getTime()-1000)}),
 ];
 compactCases[7].scheduler={...compactCases[7].scheduler,phase:'LEARNING',queue:'MINUTE',remainingSteps:1,options:{...DEFAULT_OPTIONS,learnAheadSeconds:7200},timeZone:'America/New_York',rollover:2};
 compactCases[2].scheduler.options={...compactCases[2].scheduler.options,relearningSteps:[3,17],buryReviews:true,leechThreshold:4};
 fixture.userprogresses=[...compactCases,progress(90,'WORD',20,{userId:otherOwner})];
 const compactArgs={dueLimit:5000,newLimit:0,includeLearningAhead:true};
 const oldRaw=await resolvers.Query.dueItems(null,{userId:String(owner),...compactArgs},{user} as any);
 progressQueries=[];
 const compact=JSON.parse(JSON.stringify(await loadCompactStudyQueue(user as any,{...compactArgs,cardLimit:2})));
 assert.deepEqual(compact.manifest.map((row:any)=>row.id),oldRaw.map((row:any)=>row.itemId),'starter hydration must preserve the full due/new/ahead order');
 assert.equal(compact.items.length,2);assert.equal(compact.remaining,compact.manifest.length-2);assert.equal(compact.complete,false);
 assert.ok(progressQueries.some(read=>read.projection?.scheduler && read.projection?.['card.direction'] && !read.projection.card && !read.projection.failureAttemptIds),'selection excludes rich cards and history');
 const remainder=JSON.parse(JSON.stringify(await loadCompactStudyCards(user as any,{itemIds:compact.manifest.slice(2).map((row:any)=>row.id)})));
 const expanded=(row:any,profiles:any[])=>({itemId:row.id,itemType:row.type,...row.schedule.state,scheduler:{...row.schedule.state.scheduler,options:profiles[row.schedule.profile]}});
 const fullCompact=JSON.parse(JSON.stringify(await loadCompactStudyQueue(user as any,compactArgs)));
 assert.deepEqual(fullCompact.manifest,[],'a complete response does not send duplicate manifest state/content');
 assert.deepEqual(fullCompact.items.map((row:any)=>row.id),compact.manifest.map((row:any)=>row.id));
 assert.equal(fullCompact.complete,true);assert.equal(fullCompact.remaining,0);
 for(const row of fullCompact.items){assert.equal(row.schedule.state.itemId,undefined);assert.equal(row.schedule.state.itemType,undefined);}
 const emptyCompact=await loadCompactStudyQueue(user as any,{dueLimit:0,newLimit:0});
 assert.deepEqual(emptyCompact.items,[]);assert.deepEqual(emptyCompact.manifest,[]);assert.equal(emptyCompact.complete,true);
 const hydrated=[...compact.items.map((row:any)=>({row,profiles:compact.profiles})),...remainder.items.map((row:any)=>({row,profiles:remainder.profiles}))];
 for(const {row,profiles} of hydrated){
  const original=oldRaw.find((p:any)=>p.itemId===row.id),state=expanded(row,profiles),oldState=JSON.parse(original.studyState);
  delete oldState.card;
  assert.deepEqual(state,oldState,`complete local scheduling state for ${row.id}`);
  const redate=(value:any)=>{value=structuredClone(value);for(const key of ['nextDueDate','temporaryDueDate','lastReviewed','createdAt'])if(value[key])value[key]=new RealDate(value[key]);return value;};
  for(const grade of ['AGAIN','HARD','GOOD','EASY'] as const)assert.deepEqual(scheduleStudyReview(redate(state),grade,now),scheduleStudyReview(redate(oldState),grade,now),'all compact local transitions match the old state');
  assert.equal(row.contexts[0],original.loadedWordRelation?.mainDoc && original.loadedWordRelation?.translatedDoc ? original.loadedWordRelation.mainDoc.contexts?.[0] : original.loadedPhraseRelation?.mainDoc && original.loadedPhraseRelation?.translatedDoc ? original.loadedPhraseRelation.mainDoc.contexts?.[0] : undefined);
  if(original.card){assert.equal(row.card.notes,original.card.notes);assert.deepEqual(row.card.examples,original.card.examples);assert.deepEqual(row.card.acceptedAnswers,original.card.acceptedAnswers);}
 }
 const legacyWord=hydrated.find(({row}:any)=>row.id===String(compactCases[2].itemId))!.row;
 assert.equal(legacyWord.wordNotes,'note');assert.equal(legacyWord.forms.article,'das');assert.deepEqual(legacyWord.examples,['Haus example']);
 const legacyPhrase=hydrated.find(({row}:any)=>row.id===String(compactCases[4].itemId))!.row;
 assert.deepEqual(legacyPhrase.synonyms,['alternative']);
 const missing=hydrated.find(({row}:any)=>row.id===String(compactCases[6].itemId))!.row;
 assert.equal(missing.german,'');assert.equal(missing.spanish,'');assert.deepEqual(missing.contexts,[]);
 assert.equal(hydrated.find(({row}:any)=>row.id===String(compactCases[0].itemId))!.row.examples,undefined,'explicit-card reveal details are not duplicated from relations');
 await assert.rejects(loadCompactStudyCards(user as any,{itemIds:[String(progress(90).itemId)]}),/unavailable/i,'another owner cannot be hydrated');
 await assert.rejects(loadCompactStudyQueue(user as any,{userId:String(otherOwner)} as any),/owner/i);
 await assert.rejects(loadCompactStudyCards(user as any,{itemIds:['invalid']}),/itemIds/i);
 // Extra practice preserves future-first selection and its early-review flag.
 const oldMore=await resolvers.Query.studyMoreItems(null,{userId:String(owner),limit:2,itemType:'WORD'},{user} as any);
 const compactMore=await loadCompactStudyMore(user as any,{limit:2,itemType:'WORD'});
 assert.deepEqual(compactMore.items.map(row=>row.id),oldMore.map((row:any)=>row.itemId));
 assert.deepEqual(compactMore.items.map(row=>!!row.extraPractice),oldMore.map((row:any)=>!!row.extraPractice));
 // Actual new native-word allocation is exercised only against this mock store.
 const freshNative=()=>progress(91,'WORD',20,{isNew:true,interval:0,repetitions:0,totalReviews:0,lapses:0,lastReviewed:null});
 fixture.userprogresses=[freshNative()];
 const oldNative=await resolvers.Query.dueItems(null,{userId:String(owner),dueLimit:5000,newLimit:2,itemType:'WORD',includeLearningAhead:true},{user} as any);
 fixture.userprogresses=[freshNative()];
 const compactNative=await loadCompactStudyQueue(user as any,{dueLimit:5000,newLimit:2,itemType:'WORD',cardLimit:1});
 assert.deepEqual((compactNative.manifest.length?compactNative.manifest:compactNative.items).map(row=>row.id),oldNative.map((row:any)=>row.itemId));
 assert.equal(compactNative.items.length,2,'starter boundary includes the complete new directional pair');
 assert.deepEqual(compactNative.items.map(row=>row.card?.direction),['DE_ES','ES_DE']);
 assert.ok(compactNative.items.every(row=>row.card?.notes==='note' && row.card.examples[0]==='Haus example (casa example)'));
 assert.equal(fixture.userprogresses.length,2,'one native pair is allocated');
 await loadCompactStudyQueue(user as any,{dueLimit:5000,newLimit:2,itemType:'WORD',cardLimit:1});
 assert.equal(fixture.userprogresses.length,2,'repeat startup is idempotent');
 await assert.rejects(loadCompactStudyQueue(user as any,{cardLimit:-1}),/cardLimit/);
 assert.equal(fixture.userprogresses.length,2,'invalid requests are rejected before allocation');
 const transportApp=express();transportApp.use(express.json());transportApp.use(studyTransportRouter({authenticate:async token=>token==='mock-owner'?user as any:null}));
 const transportServer=transportApp.listen(0,'127.0.0.1');
 try{
  await new Promise<void>(resolve=>transportServer.once('listening',()=>resolve()));
  const port=(transportServer.address() as any).port;
  const post=(path:string,body:any,token='mock-owner')=>fetch(`http://127.0.0.1:${port}/api/study/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  const unauthorized=await post('queue',{},'not-owner');assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers.get('cache-control'),'no-store');
  const foreign=await post('cards',{itemIds:[String(progress(90).itemId)]});assert.equal(foreign.status,400);
  const response=await post('queue',{dueLimit:5000,newLimit:2,itemType:'WORD',cardLimit:1});assert.equal(response.status,200);assert.equal((await response.json()).items.length,2);
  const invalid=await post('queue',{newLimit:'40'});assert.equal(invalid.status,400);
 }finally{await new Promise<void>((resolve,reject)=>transportServer.close(error=>error?reject(error):resolve()));}
 console.log('PASS compact ordered starter/background transport, custom profiles/timezones, local schedule transitions, reveal content, legacy/cloze/missing links and ownership');
}finally{await closeDatabase();(globalThis as any).Date=RealDate;}
