import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { typeDefs, resolvers } from '../src/graphql/schema.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { initialScheduler, DEFAULT_OPTIONS, studyDay, schedulerSeed } from '../src/features/progress/scheduler.js';
import { syncStudy, validateStudyOperations, type StudyOperation } from '../src/features/progress/studySync.js';
import { dailyCounts } from '../src/features/progress/reviews.js';
import { introducedToday } from '../src/features/progress/dailyLimit.js';
import { scheduleStudyReview } from '../src/features/progress/studyScheduling.js';
import { scheduleStudyReview as browserSchedule } from '../../german-gramatic-web/src/core/generated/studyScheduler.js';

if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/')) throw new Error('Use the disposable loopback MongoDB on port 27019 for these tests.');
const db = await connectDatabase(), userId = new ObjectId(), otherId = new ObjectId(), now = new Date(), sessionId = randomUUID();
const schema = makeExecutableSchema({typeDefs,resolvers});
const options = {...DEFAULT_OPTIONS,reviewsPerDay:5000,newPerDay:1000};
const call = async (source: string, vars: any = {}) => graphql({schema,source,variableValues:{userId:String(userId),...vars},contextValue:{user:{_id:userId}}});
const created: ObjectId[] = [];
const make = async (extra: any = {}) => {
  const p: any = {_id:new ObjectId(),userId,itemId:new ObjectId(),itemType:'WORD',isNew:true,failureIndex:0,ease:2.5,interval:0,repetitions:0,totalReviews:0,lapses:0,nextDueDate:now,lastReviewed:null,createdAt:now,...extra};
  p.scheduler = initialScheduler(p,options);created.push(p._id);await db.progress.insertOne(p);return p;
};
const op = (p: any, extra: any = {}): StudyOperation => ({id:randomUUID(),kind:'REVIEW',itemId:String(p.itemId),itemType:p.itemType,grade:'GOOD',expectedVersion:0,occurredAt:now.toISOString(),sessionId,...extra});
try {
  await db.users.insertMany([{_id:userId,email:`sync-${userId}@example.invalid`,authProvider:'email',settings:{...defaultUserSettings,dailyNewCards:4},createdAt:now},{_id:otherId,email:`sync-${otherId}@example.invalid`,authProvider:'email',settings:defaultUserSettings,createdAt:now}]);
  const cards: any[]=[];
  for (let note=1;note<=4;note++) for (const direction of ['DE_ES','ES_DE']) cards.push(await make({card:{source:'ANKI',sourceCardId:String(1790000000000+cards.length),sourceNoteGuid:`sync-${userId}-${note}`,direction,prompt:'test',answer:'test',acceptedAnswers:['test'],notes:'',examples:[],deck:'Deck::Child',tags:[]},anki:{type:0,queue:0,left:0,reps:0,did:1,due:note}}));
  const queue = await call('query($userId:ID!){dueItems(userId:$userId,itemType:"WORD",newLimit:1000,dueLimit:5000){itemId card{direction} studyState}studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review}}');
  assert.equal(queue.errors,undefined);assert.equal((queue.data as any).dueItems.length,4);assert.deepEqual((queue.data as any).dueItems.map((p:any)=>p.card.direction),['DE_ES','ES_DE','DE_ES','ES_DE']);assert.equal((queue.data as any).studyQueueCounts.new,4);
  const recognition = op(cards[0]);assert.equal((await syncStudy(userId,[recognition])).results[0].success,true);
  const counts = await call('query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review}}');
  assert.deepEqual(JSON.parse(JSON.stringify((counts.data as any).studyQueueCounts)),{new:3,learning:1,review:0});
  assert.equal((await syncStudy(userId,[recognition])).results[0].success,true);assert.equal(await db.reviewEvents.countDocuments({userId}),1);
  const typing = op(cards[1]);assert.equal((await syncStudy(userId,[typing])).results[0].success,true);
  const racing = await Promise.all([syncStudy(userId,[op(cards[2])]),syncStudy(userId,[op(cards[4])]),syncStudy(userId,[op(cards[6])])]);
  assert.equal(racing.flatMap(x=>x.results).filter(x=>x.success).length,2);assert.equal(introducedToday(await dailyCounts(userId,studyDay(now,'Europe/Berlin',4))),4);
  const paused = await call('mutation($userId:ID!){syncSettings(userId:$userId,settings:{dailyNewCards:0}){settings{dailyNewCards}}}');assert.equal(paused.errors,undefined);
  const zero=await call('query($userId:ID!){dueItems(userId:$userId,newLimit:1000,dueLimit:5000){schedulerPhase}studyQueueCounts(userId:$userId){new learning}}');assert.equal((zero.data as any).studyQueueCounts.new,0);assert.ok((zero.data as any).studyQueueCounts.learning>=2);
  assert.ok((await call('mutation($userId:ID!){syncSettings(userId:$userId,settings:{dailyNewCards:-1}){id}}')).errors);
  assert.ok((await call('mutation($userId:ID!){syncSettings(userId:$userId,settings:{dailyNewCards:1001}){id}}')).errors);
  await call('mutation($userId:ID!){syncSettings(userId:$userId,settings:{dailyNewCards:5}){id}}');
  const lastPlace=await call('query($userId:ID!){dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:1000){itemId card{direction}}studyQueueCounts(userId:$userId,itemType:"WORD"){new}}');
  assert.equal((lastPlace.data as any).studyQueueCounts.new,1);assert.equal((lastPlace.data as any).dueItems.length,1,'one remaining daily place supplies exactly one card');
  const lastCard=cards.find(p=>String(p.itemId)===(lastPlace.data as any).dueItems[0].itemId);assert.ok(lastCard);assert.equal((await syncStudy(userId,[op(lastCard)])).results[0].success,true);
  const exhausted=await call('query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new}}');assert.equal((exhausted.data as any).studyQueueCounts.new,0);
  await call('mutation($userId:ID!){syncSettings(userId:$userId,settings:{dailyNewCards:6}){id}}');
  const nextPlace=await call('query($userId:ID!){dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:1000){card{direction}}}');assert.equal((nextPlace.data as any).dueItems.length,1);
  await db.users.updateOne({_id:otherId},{$set:{'settings.dailyNewCards':1}});
  const onePair=cards.slice(0,2).map(card=>({...card,_id:new ObjectId(),itemId:new ObjectId(),userId:otherId,card:{...card.card,sourceNoteGuid:'one-per-day'}}));await db.progress.insertMany(onePair);
  const otherQueue=()=>graphql({schema,source:'query($userId:ID!){dueItems(userId:$userId,itemType:"WORD",dueLimit:0,newLimit:1000){itemId card{direction}}studyQueueCounts(userId:$userId,itemType:"WORD"){new}}',variableValues:{userId:String(otherId)},contextValue:{user:{_id:otherId}}});
  const one=await otherQueue();assert.deepEqual((one.data as any).dueItems.map((p:any)=>p.card.direction),['DE_ES']);assert.equal((one.data as any).studyQueueCounts.new,1);
  const yesterday=new Date(now.getTime()-86400000);assert.equal((await syncStudy(otherId,[op(onePair[0],{occurredAt:yesterday.toISOString()})])).results[0].success,true);
  const tomorrow=await otherQueue();assert.deepEqual((tomorrow.data as any).dueItems.map((p:any)=>p.card.direction),['ES_DE'],'a one-card daily allowance unlocks typing after the earlier-day introduction');
  console.log('PASS daily card cap, paired Anki order, blue-to-red transition, shared/concurrent quota, pause, and validated settings');

  const mature=await make({isNew:false,interval:100,repetitions:8,totalReviews:20,nextDueDate:new Date(now.getTime()-86400000),lastReviewed:new Date(now.getTime()-8640000000)});
  const failure=op(mature,{kind:'FAILURE'}),review=op(mature,{grade:'REVISIT'}),undo=op(mature,{kind:'UNDO',reviewId:review.id});
  const batch=[failure,review,undo];assert.ok((await syncStudy(userId,batch)).results.every(x=>x.success));assert.ok((await syncStudy(userId,batch)).results.every(x=>x.success===true||x.code==='REVIEW_UNDONE'));
  const stored=await db.progress.findOne({_id:mature._id});assert.equal(stored.failureIndex,2);assert.equal(stored.interval,100);assert.equal(stored.temporaryDueDate,undefined);
  const earlier=new Date(now.getTime()-86400000), delayed=op(mature,{expectedVersion:2,occurredAt:earlier.toISOString(),grade:'EASY'});
  assert.equal((await syncStudy(userId,[delayed])).results[0].success,true);const event=await db.reviewEvents.findOne({userId,reviewId:delayed.id});assert.equal(event.reviewedAt.toISOString(),earlier.toISOString());assert.equal(event.day,studyDay(earlier,'Europe/Berlin',4));assert.equal(event.studySessionId,sessionId);assert.ok(event.syncedAt);
  const wrongOwner = await syncStudy(otherId,[op(mature)]);assert.equal(wrongOwner.results[0].success,false);assert.equal((await db.progress.findOne({_id:mature._id})).scheduleVersion,3);
  const conflict=await syncStudy(userId,[op(mature),op(mature,{expectedVersion:1}),op(mature,{kind:'FAILURE'})]);assert.deepEqual(conflict.results.map(x=>x.code),['STALE_CARD','DEPENDENCY_CONFLICT',undefined]);assert.equal((await db.progress.findOne({_id:mature._id})).failureIndex,3);
  console.log('PASS batch retries, independent durable mistakes/Revisit, ordered Undo, original timestamps, ownership and stale-card conflict without overwrites');

  const many=[];for(let i=0;i<100;i++) many.push(op(await make({itemType:'PHRASE',isNew:false,interval:30,repetitions:1,lastReviewed:earlier}),{grade:'EASY'}));
  assert.ok((await syncStudy(userId,many)).results.every(x=>x.success));assert.ok((await syncStudy(userId,many)).results.every(x=>x.success));assert.equal(await db.reviewEvents.countDocuments({userId,reviewId:{$in:many.map(x=>x.id)}}),100);
  assert.throws(()=>validateStudyOperations([...many,many[0]]));assert.throws(()=>validateStudyOperations([{...many[0],occurredAt:'invalid'}]));
  for(const phase of ['NEW','LEARNING','REVIEW','RELEARNING']) for(const kind of ['WORD','PHRASE']) for(const stamp of ['2026-03-28T20:10:00Z','2026-10-24T23:50:00Z','2026-10-06T12:00:00Z']) {
    const p:any={...mature,itemType:kind,scheduler:{...mature.scheduler,phase,queue:phase==='NEW'?'NEW':'DAY',remainingSteps:2,interval:100},nextDueDate:new Date(stamp),temporaryDueDate:undefined};
    const browser:any={...p,itemId:String(p.itemId),fuzzSeed:schedulerSeed(p).toString()};
    for(const grade of ['AGAIN','HARD','GOOD','EASY']) assert.deepEqual(browserSchedule(browser,grade as any,new Date(stamp)),scheduleStudyReview(p,grade as any,new Date(stamp)));
  }
  console.log('PASS 100-card batch + exact replay and browser/server scheduler parity across phases, phrases and DST');
} finally { await db.reviewEvents.deleteMany({userId:{$in:[userId,otherId]}});await db.progress.deleteMany({userId:{$in:[userId,otherId]}});await db.users.deleteMany({_id:{$in:[userId,otherId]}});await db.schedulerProfiles.deleteOne({_id:userId});await closeDatabase(); }
