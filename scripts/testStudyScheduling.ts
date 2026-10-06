import assert from 'node:assert/strict';
import {ObjectId} from 'mongodb';
import {initialScheduler} from '../src/features/progress/scheduler.js';
import {scheduleStudyReview,studyReviewOptions,effectiveDueDate} from '../src/features/progress/studyScheduling.js';
import type {UserProgress} from '../src/features/progress/progress.types.js';
const now=new Date('2026-10-24T10:00:00Z');
const p:UserProgress={_id:new ObjectId(),userId:new ObjectId(),itemId:new ObjectId(),itemType:'WORD',interval:100,ease:2.5,repetitions:8,totalReviews:20,nextDueDate:now,lastReviewed:new Date('2026-07-16T10:00:00Z'),createdAt:now};p.scheduler=initialScheduler(p);
const revisit=scheduleStudyReview(p,'REVISIT',now);assert.equal(effectiveDueDate({...p,...revisit}).getTime()-now.getTime(),86400000);
assert.ok(revisit.nextDueDate.getTime()>now.getTime()+100*86400000);
for(const grade of ['AGAIN','HARD','GOOD','EASY']as const){const completed=scheduleStudyReview({...p,...revisit},grade,new Date(now.getTime()+86400000));assert.equal(completed.nextDueDate.toISOString(),revisit.nextDueDate.toISOString());assert.equal(completed.interval,revisit.interval);assert.equal(completed.ease,revisit.ease);assert.equal(completed.temporaryDueDate,undefined);}
const future={...p,nextDueDate:new Date(now.getTime()+180*86400000)};assert.equal(scheduleStudyReview(future,'REVISIT',now).nextDueDate,future.nextDueDate);
assert.ok(!studyReviewOptions({...future,nextDueDate:new Date(now.getTime()+3600000)},now).some(o=>o.grade==='REVISIT'),'extra practice cannot delay an earlier regular review');
const late=scheduleStudyReview({...p,temporaryDueDate:new Date(now.getTime()-86400000)},'GOOD',now);assert.ok(late.nextDueDate>now);assert.equal(late.temporaryDueDate,undefined);
const phrase={...p,itemType:'PHRASE' as const};assert.deepEqual(studyReviewOptions(phrase,now).map(o=>o.delaySeconds),[7,30,180,365].map(d=>d*86400));
assert.throws(()=>scheduleStudyReview(phrase,'REVISIT',now),/established word/);
console.log('PASS tomorrow extra review across DST, unchanged regular scheduling, all completion grades, late reviews, earlier due protection and phrase policy');
