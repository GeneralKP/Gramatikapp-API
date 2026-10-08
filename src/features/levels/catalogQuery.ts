import { CEFR_LEVELS } from "./levels.js";
import { reviewedWordContentExpression } from "../words/reviewedWordContent.js";
export interface CatalogArgs { limit?: number; offset?: number; search?: string; cefrLevel?: string }
export function catalogPipeline(args: CatalogArgs, mainCollection: string, translatedCollection: string, field: "word" | "phrase", projection?: Record<string, number>) {
  const limit = Math.min(500, Math.max(1, Math.trunc(args.limit ?? 100))), offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const search = (args.search ?? "").trim();
  if (search.length > 200) throw new Error("Search must be 200 characters or fewer");
  if (args.cefrLevel && !CEFR_LEVELS.includes(args.cefrLevel as any)) throw new Error("Invalid CEFR level");
  const match: any = {};
  if (search) {
    const regex = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.$or = [{ [`mainDocs.${field}`]: { $regex: regex, $options: "i" } }, { [`translatedDocs.${field}`]: { $regex: regex, $options: "i" } }];
    if (field === "word") match.$or.push(
      { __catalogGerman: { $regex: regex, $options: "i" } },
      { __catalogSpanish: { $regex: regex, $options: "i" } },
    );
  }
  if (args.cefrLevel) match["translatedDocs.cefrLevel"] = args.cefrLevel;
  return [
    { $lookup: { from: mainCollection, localField: "main", foreignField: "_id", as: "mainDocs" } },
    { $lookup: { from: translatedCollection, localField: "translated", foreignField: "_id", as: "translatedDocs" } },
    ...(field === "word" ? [{ $set: {
      __catalogGerman: { $cond: [reviewedWordContentExpression, "$study.german", "$translatedDocs.word"] },
      __catalogSpanish: { $cond: [reviewedWordContentExpression, "$study.spanish", "$mainDocs.word"] },
    } }] : []),
    { $match: match }, { $sort: { [field === "word" ? "__catalogGerman" : "translatedDocs.phrase"]: 1, _id: 1 } }, { $skip: offset }, { $limit: limit },
    ...(field === "word" ? [{ $unset: ["__catalogGerman", "__catalogSpanish"] }] : []),
    ...(projection ? [{ $project: projection }] : []),
  ];
}
