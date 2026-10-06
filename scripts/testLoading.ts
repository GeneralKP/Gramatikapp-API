import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoClient, ObjectId } from 'mongodb';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { connectDatabase, closeDatabase, getDb } from '../src/lib/database.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { withScheduler } from '../src/features/progress/reviews.js';
import { insertNewProgress } from '../src/features/progress/studyLoading.js';

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
let batches:any[]=[];
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
  find(query:any={}){count('find');let rows=(fixture[name]??[]).filter((doc:any)=>matches(doc,query));return {
   project(fields:any){rows=rows.map((row:any)=>project(row,fields));return this;},
   sort(fields:any){const [key,direction]=Object.entries(fields)[0] as [string,number];rows.sort((a:any,b:any)=>(valueAt(a,key)>valueAt(b,key)?1:valueAt(a,key)<valueAt(b,key)?-1:0)*direction);return this;},
   limit(size:number){if(size)rows=rows.slice(0,size);return this;},
   async toArray(){return rows;},
  };},
  async findOne(query:any,options:any={}){count('findOne');const row=(fixture[name]??[]).find((doc:any)=>matches(doc,query));return row ? options.projection ? project(row,options.projection):row : null;},
  async bulkWrite(operations:any[],options:any){
   assert.equal(name,'userprogresses');assert.deepEqual(options,{ordered:false});batches.push(operations);
   for(const {updateOne} of operations){
    assert.equal(updateOne.upsert,true);assert.deepEqual(Object.keys(updateOne.update),['$setOnInsert']);
    if(!fixture[name].some((doc:any)=>matches(doc,updateOne.filter)))fixture[name].push(updateOne.update.$setOnInsert);
   }
  },
  aggregate(){count('aggregate');assert.equal(name,'reviewevents');return {async toArray(){return [];}};},
 };
 collections.set(name,result);return result;
}
MongoClient.prototype.connect=async function(){return this;};
MongoClient.prototype.db=function(){return {collection} as any;};
await connectDatabase();
// Versioned client operations keep this API-only CI suite independent of the web checkout.
const queries=JSON.parse(readFileSync(new URL('./fixtures/loading-queries.json',import.meta.url),'utf8'));
const query=(name:string)=>queries[name];
const dashboard='query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review total learned} learningPath(userId:$userId){id name level isUnlocked wordsTotal wordsLearned phrasesTotal phrasesLearned}}';
try {
 const schema=makeExecutableSchema({typeDefs,resolvers});
 const responses:any={};
 const execute=async(name:string,source:string,variables:any={})=>{
  reads={};
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
  if(name==='dashboard')assert.equal(reads['userprogresses.find'],1,'counts and learning path share one progress snapshot');
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
 const aliases=await graphql({schema,source:'query($userId:ID!){first:studyQueueCounts(userId:$userId,itemType:"PHRASE",context:"University"){new learning review total learned} second:studyQueueCounts(userId:$userId,itemType:"PHRASE",context:"university"){new learning review total learned}}',variableValues:{userId:String(owner)},contextValue:{user}});
 assert.equal(aliases.errors,undefined);
 const phraseCounts=practiceResponses['phrases-counts'].data.studyQueueCounts;
 assert.deepEqual(JSON.parse(JSON.stringify(aliases.data)),{first:phraseCounts,second:phraseCounts});
 assert.equal(reads['schedulerprofiles.findOne'],1);assert.equal(reads['userprogresses.find'],1);
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
 assert.equal(reads['userprogresses.find'],2,'a full pending queue avoids the all-reviewed exclusion query');
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
}finally{await closeDatabase();(globalThis as any).Date=RealDate;}
