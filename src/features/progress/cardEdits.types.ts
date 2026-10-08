import type { ObjectId } from 'mongodb';

export const CARD_FLAGS = ['RED', 'ORANGE', 'GREEN', 'BLUE', 'PURPLE'] as const;
export type CardFlag = typeof CARD_FLAGS[number] | null;
export interface CardContent {
  german: string;
  spanish: string;
  notes: string;
  examples: string[];
}
/** Personal pair content. Catalog and imported archival notes remain untouched. */
export interface CardEdit {
  _id: ObjectId;
  userId: ObjectId;
  relationId: ObjectId;
  itemType: 'WORD' | 'PHRASE';
  version: number;
  content?: CardContent;
  flag: CardFlag;
  updatedAt: Date;
}
export interface CardEditCommand {
  relationId: string;
  expectedContentVersion: number;
  content?: CardContent;
  flag?: CardFlag;
  failureDelta?: number;
  nextDueDate?: string;
}
export interface CardEditEvent {
  _id: ObjectId;
  userId: ObjectId;
  commandId: string;
  payload: string;
  appliedAt: Date;
}
export function validateCardEdit(value: unknown): asserts value is CardEditCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid card edit.');
  const edit = value as CardEditCommand;
  if (!/^[a-f\d]{24}$/i.test(edit.relationId) || !Number.isSafeInteger(edit.expectedContentVersion) || edit.expectedContentVersion < 0) throw new Error('Invalid card edit identity.');
  if (edit.flag !== undefined && edit.flag !== null && !CARD_FLAGS.includes(edit.flag)) throw new Error('Choose one of the five flag colors.');
  if (edit.failureDelta !== undefined && (!Number.isSafeInteger(edit.failureDelta) || Math.abs(edit.failureDelta) > 1000000)) throw new Error('Invalid mistake adjustment.');
  if (edit.nextDueDate !== undefined && (typeof edit.nextDueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(edit.nextDueDate) || !Number.isFinite(Date.parse(edit.nextDueDate)) || new Date(edit.nextDueDate).toISOString() !== edit.nextDueDate || Date.parse(edit.nextDueDate) < Date.UTC(2000, 0, 1) || Date.parse(edit.nextDueDate) > Date.UTC(2100, 0, 1))) throw new Error('Choose a due date between 2000 and 2100.');
  if (edit.content !== undefined) {
    const c = edit.content;
    if (!c || typeof c !== 'object' || Array.isArray(c) || !['german', 'spanish'].every(key => typeof c[key as 'german' | 'spanish'] === 'string' && c[key as 'german' | 'spanish'].trim().length > 0 && c[key as 'german' | 'spanish'].length <= 1000) || typeof c.notes !== 'string' || c.notes.length > 10000 || !Array.isArray(c.examples) || c.examples.length > 20 || c.examples.some(example => typeof example !== 'string' || example.length > 1000)) throw new Error('Invalid card text. Keep texts under 1,000 characters, notes under 10,000 and at most 20 examples.');
    if (Object.keys(c).some(key => !['german', 'spanish', 'notes', 'examples'].includes(key))) throw new Error('Unknown card text field.');
  }
  if (edit.content === undefined && edit.flag === undefined && edit.failureDelta === undefined && edit.nextDueDate === undefined) throw new Error('The card edit is empty.');
  if (Object.keys(edit).some(key => !['relationId', 'expectedContentVersion', 'content', 'flag', 'failureDelta', 'nextDueDate'].includes(key))) throw new Error('Unknown card edit field.');
  if (Buffer.byteLength(JSON.stringify(edit), 'utf8') > 40000) throw new Error('This card edit is too large. Shorten its notes or examples.');
}
