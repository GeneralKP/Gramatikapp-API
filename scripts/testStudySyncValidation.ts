import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { validateStudyOperations } from '../src/features/progress/studySync.js';
const job={id:randomUUID(),kind:'REVIEW',itemId:String(new ObjectId()),itemType:'WORD',grade:'GOOD',expectedVersion:0,occurredAt:new Date().toISOString(),sessionId:randomUUID()};
assert.deepEqual(validateStudyOperations([job]),[job]);
for(const value of [null,[],Array(101).fill(job),[{...job,id:'bad'}],[{...job,kind:'DROP'}],[{...job,itemId:'invalid'}],[{...job,expectedVersion:-1}],[{...job,expectedVersion:0.2}],[{...job,earlyReview:'true'}],[{...job,occurredAt:'bad'}],[{...job,occurredAt:new Date(Date.now()+600000).toISOString()}],[{...job,kind:'UNDO',reviewId:'bad'}]])assert.throws(()=>validateStudyOperations(value));
assert.equal(validateStudyOperations([{...job,kind:'FAILURE'},{...job,kind:'UNDO',reviewId:job.id}]).length,2);
console.log('PASS bounded batch, ownership-shaped IDs, timestamps, grade/version validation and Undo IDs');
