import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { selectStudyQueue } from '../src/features/progress/studyQueue.js';
import { DEFAULT_OPTIONS, initialScheduler } from '../src/features/progress/scheduler.js';
import { validateStudyOperations } from '../src/features/progress/studySync.js';
const job={id:randomUUID(),kind:'REVIEW',itemId:String(new ObjectId()),itemType:'WORD',grade:'GOOD',expectedVersion:0,occurredAt:new Date().toISOString(),sessionId:randomUUID()};
assert.deepEqual(validateStudyOperations([job]),[job]);
for(const value of [null,[],Array(101).fill(job),[{...job,id:'bad'}],[{...job,kind:'DROP'}],[{...job,itemId:'invalid'}],[{...job,expectedVersion:-1}],[{...job,expectedVersion:0.2}],[{...job,earlyReview:'true'}],[{...job,occurredAt:'bad'}],[{...job,occurredAt:new Date(Date.now()+600000).toISOString()}],[{...job,kind:'UNDO',reviewId:'bad'}]])assert.throws(()=>validateStudyOperations(value));
assert.equal(validateStudyOperations([{...job,kind:'FAILURE'},{...job,kind:'UNDO',reviewId:job.id}]).length,2);
console.log('PASS bounded batch, ownership-shaped IDs, timestamps, grade/version validation and Undo IDs');

const now=new Date(),pair=['DE_ES','ES_DE'].map(direction=>{const p:any={_id:new ObjectId(),itemId:new ObjectId(),itemType:'WORD',isNew:true,ease:2.5,interval:0,repetitions:0,totalReviews:0,lapses:0,nextDueDate:now,lastReviewed:null,createdAt:now,card:{sourceNoteGuid:'one-a-day',direction,deck:'App'}};p.scheduler=initialScheduler(p,{...DEFAULT_OPTIONS,newPerDay:1});return p});
assert.deepEqual(selectStudyQueue(pair,new Map(),now,0,1,true).map(p=>p.card.direction),['DE_ES']);
assert.equal(selectStudyQueue(pair,new Map(),now,0,1).length,0,'ordinary small fetches still preserve complete introductions');
assert.equal(selectStudyQueue(pair,new Map([['App',{new:1,review:0}]]),now,0,1,true).length,0);
console.log('PASS individual daily cap of one, recognition-first order, cap exhaustion and ordinary paired fetches');
