import 'dotenv/config';
import assert from 'node:assert/strict';
import {ObjectId} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {connectDatabase,closeDatabase} from '../src/lib/database.js';
import {saveReview,undoReview,withScheduler} from '../src/features/progress/reviews.js';
import {scheduleStudyReview,studyReviewOptions} from '../src/features/progress/studyScheduling.js';
import {initialScheduler,DEFAULT_OPTIONS} from '../src/features/progress/scheduler.js';
import {selectStudyQueue} from '../src/features/progress/studyQueue.js';
import {recordFailure} from '../src/features/progress/failures.js';
import {typeDefs,resolvers} from '../src/graphql/schema.js';
import {makeExecutableSchema} from '@graphql-tools/schema';
import {graphql} from 'graphql';
const db=await connectDatabase(), userId=new ObjectId(), ids:ObjectId[]=[];
const schema=makeExecutableSchema({typeDefs,resolvers});
const now=new Date();
const make=async(extra:any={})=>{const p:any={_id:new ObjectId(),userId,itemId:new ObjectId(),itemType:'WORD',failureIndex:0,isNew:false,interval:100,ease:2.5,repetitions:8,totalReviews:20,lapses:2,nextDueDate:new Date(now.getTime()-1000),lastReviewed:new Date(now.getTime()-8640000000),createdAt:now,...extra};p.scheduler=initialScheduler(p);await db.progress.insertOne(p);return p;};
const call=async(source:string,vars:any={})=>{const result=await graphql({schema,source,variableValues:{userId:String(userId),...vars},contextValue:{user:{_id:userId}}});assert.equal(result.errors,undefined,result.errors?.map(x=>x.message).join(';'));return result.data as any;};
try {
 const p=await make(), reviewId=randomUUID(), attemptId=randomUUID();
 await recordFailure(db.progress,userId,p.itemId,attemptId);
 const result=await saveReview(userId,p.itemId,'WORD','REVISIT',reviewId,0,false,attemptId);
 const stored=result.progress;assert.equal(stored.failureIndex,1,'typed failure and Revisit deduplicate the same attempt');
 assert.ok(stored.nextDueDate.getTime()>now.getTime()+100*86400000,'regular future schedule established for a due mature card');
 assert.ok(Math.abs(stored.temporaryDueDate.getTime()-Date.now()-86400000)<10000);
 const repeated=await saveReview(userId,p.itemId,'WORD','REVISIT',reviewId,0,false,attemptId);assert.equal(repeated.progress.failureIndex,1);
 assert.ok(selectStudyQueue([await withScheduler(stored)],new Map([['App',{new:99999,review:99999}]]),new Date(stored.temporaryDueDate.getTime()+1),50,0).length===1,'extra review remains available after ordinary daily cap');
 const baseDue=stored.nextDueDate.toISOString(),interval=stored.interval,ease=stored.ease;
 await db.progress.updateOne({_id:stored._id},{$set:{temporaryDueDate:new Date(now.getTime()-1)}});
 const completeId=randomUUID(),complete=await saveReview(userId,p.itemId,'WORD','HARD',completeId,1);
 assert.equal(complete.progress.temporaryDueDate,undefined);assert.equal(complete.progress.nextDueDate.toISOString(),baseDue);assert.equal(complete.progress.interval,interval);assert.equal(complete.progress.ease,ease);
 await undoReview(userId,completeId);assert.ok((await db.progress.findOne({_id:p._id})).temporaryDueDate,'Undo restores pending extra review');
 await undoReview(userId,reviewId);assert.equal((await db.progress.findOne({_id:p._id})).temporaryDueDate,undefined);assert.equal((await db.progress.findOne({_id:p._id})).failureIndex,1,'Undo preserves failures');
 const future=await make({nextDueDate:new Date(now.getTime()+180*86400000)});const revisit=await saveReview(userId,future.itemId,'WORD','REVISIT',randomUUID(),0);assert.equal(revisit.progress.nextDueDate.toISOString(),future.nextDueDate.toISOString());assert.equal(revisit.progress.interval,100);assert.equal(revisit.progress.failureIndex,1);assert.equal((await db.reviewEvents.findOne({userId,reviewId:revisit.reviewId})).reviewCount,0);
 const soon=await make({nextDueDate:new Date(now.getTime()+3600000)});await assert.rejects(()=>saveReview(userId,soon.itemId,'WORD','REVISIT',randomUUID(),0),error=>(error as any).code==='REVISIT_UNAVAILABLE');
 const phrase=await make({itemType:'PHRASE'});
 for(const [index,grade] of ['AGAIN','HARD','GOOD','EASY'].entries()){const next=scheduleStudyReview(phrase,grade as any,now);assert.equal(next.interval,[7,30,180,365][index]);assert.equal(next.scheduler.queue,'DAY');assert.equal(studyReviewOptions(phrase,now)[index].delaySeconds,[7,30,180,365][index]*86400);}
 const phraseSaved=await saveReview(userId,phrase.itemId,'PHRASE','AGAIN',randomUUID(),0);assert.equal(phraseSaved.progress.interval,7);
 console.log('PASS extra review tomorrow, durable schedule/failure deduplication, retry/Undo, future dates, cap handling and phrase intervals');
 // The first unrelated entries deliberately precede the selected category.
 for(const category of ['study_control_other','study_control_selected']){const es=new ObjectId(),de=new ObjectId(),rel=new ObjectId();ids.push(es,de,rel);await db.wordsES.insertOne({_id:es,word:category,gramaticalCategories:[],examples:[],contexts:[category],createdAt:now});await db.wordsDE.insertOne({_id:de,word:category,gramaticalCategories:[],examples:[],contexts:[category],createdAt:now});await db.relationsWordsEsDe.insertOne({_id:rel,main:es,translated:de,createdAt:now});await make({itemId:rel,relationId:rel});}
 const source='query($userId:ID!,$context:String!){dueItems(userId:$userId,itemType:"WORD",context:$context,dueLimit:1,newLimit:0){itemId} studyQueueCounts(userId:$userId,itemType:"WORD",context:$context){new learning review}}';
 const filtered=await call(source,{context:'study_control_selected'});assert.equal(filtered.dueItems.length,1);assert.equal(filtered.dueItems[0].itemId,String(ids[5]));assert.equal(filtered.studyQueueCounts.review,1);
 await make({isNew:true,interval:0,lastReviewed:null,repetitions:0});await make({isNew:false,interval:0,lastReviewed:null,scheduler:undefined}).then(async p=>{p.scheduler.phase='LEARNING';p.scheduler.queue='MINUTE';await db.progress.updateOne({_id:p._id},{$set:{scheduler:p.scheduler}});});
 const totals=await call('query($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review}}');assert.equal(totals.studyQueueCounts.new,1);assert.equal(totals.studyQueueCounts.learning,1);assert.equal(totals.studyQueueCounts.review,3);
 const categoryNew=await make({itemId:new ObjectId(),relationId:ids[5],isNew:true,interval:0,lastReviewed:null,repetitions:0});
 const newFiltered=await call('query($userId:ID!){dueItems(userId:$userId,itemType:"WORD",context:"study_control_selected",dueLimit:0,newLimit:2){itemId}}');assert.equal(newFiltered.dueItems.length,2);assert.equal(newFiltered.dueItems[1].itemId,String(categoryNew.itemId));
 console.log('PASS category filtering before queue limit, separate accurate new/learning/due counts and category new cards');
}finally{await db.progress.deleteMany({userId});await db.reviewEvents.deleteMany({userId});await db.wordsES.deleteMany({_id:{$in:ids}});await db.wordsDE.deleteMany({_id:{$in:ids}});await db.relationsWordsEsDe.deleteMany({_id:{$in:ids}});await closeDatabase();}
