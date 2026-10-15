import type { ObjectId } from "mongodb";
import { isGraduatedStudyIdentity, type StudyIdentity } from "./studySummaries.js";

interface ContextMetadata { _id: ObjectId; contexts?: string[]; level?: string }
interface ContextRelation { _id: ObjectId; main: ObjectId }
interface LearningPathCatalog {
  words: ContextRelation[];
  phrases: ContextRelation[];
  wordMeta: ContextMetadata[];
  phraseMeta: ContextMetadata[];
}
export interface LearningPathNode {
  id: string;
  name: string;
  level: string;
  isUnlocked: boolean;
  wordsTotal: number;
  wordsLearned: number;
  phrasesTotal: number;
  phrasesLearned: number;
}

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

/** Shared contexts take their level from the first word, then the first phrase. */
export function buildLearningPath(progresses: StudyIdentity[], catalog: LearningPathCatalog): LearningPathNode[] {
  const learned = new Set(progresses.filter(isGraduatedStudyIdentity).map(row => String(row.relationId || row.itemId)));
  const nodesByContext: Record<string, LearningPathNode> = {};

  function addContexts(relations: ContextRelation[], metadata: ContextMetadata[], type: "words" | "phrases") {
    const byId = new Map(metadata.map(row => [String(row._id), row]));
    const totalKey = type === "words" ? "wordsTotal" : "phrasesTotal";
    const learnedKey = type === "words" ? "wordsLearned" : "phrasesLearned";
    for (const relation of relations) {
      const meta = byId.get(String(relation.main));
      if (!meta?.contexts?.length) continue;
      for (const context of meta.contexts) {
        const node = nodesByContext[context] ??= {
          id: context,
          name: context.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()),
          level: meta.level || "A1",
          isUnlocked: false,
          wordsTotal: 0,
          wordsLearned: 0,
          phrasesTotal: 0,
          phrasesLearned: 0,
        };
        node[totalKey]++;
        if (learned.has(String(relation._id))) node[learnedKey]++;
      }
    }
  }

  addContexts(catalog.words, catalog.wordMeta, "words");
  addContexts(catalog.phrases, catalog.phraseMeta, "phrases");
  const nodes = Object.values(nodesByContext);
  const mastery: Record<string, number> = {};
  for (const level of LEVELS) {
    const inLevel = nodes.filter(node => node.level === level);
    const total = inLevel.reduce((sum, node) => sum + node.wordsTotal + node.phrasesTotal, 0);
    const completed = inLevel.reduce((sum, node) => sum + node.wordsLearned + node.phrasesLearned, 0);
    mastery[level] = inLevel.length === 0 ? 100 : total > 0 ? completed / total * 100 : 0;
  }
  for (const node of nodes) {
    const levelIndex = LEVELS.indexOf(node.level);
    // Existing progression depends on the immediate previous level at >=50%.
    node.isUnlocked = levelIndex === 0 || mastery[LEVELS[levelIndex - 1]] >= 50;
    if (node.id === "lang_party") node.name = "Language Party";
    if (node.id === "colombian_compliments") node.name = "Colombian Compliments";
  }
  return nodes.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.id.localeCompare(b.id));
}
