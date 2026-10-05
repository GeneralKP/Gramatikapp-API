import { CEFR_LEVELS } from "./levels.js";
export interface CatalogArgs { limit?: number; offset?: number; search?: string; cefrLevel?: string }
export function catalogPipeline(args: CatalogArgs, mainCollection: string, translatedCollection: string, field: "word" | "phrase") {
  const limit = Math.min(500, Math.max(1, Math.trunc(args.limit ?? 100))), offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const search = (args.search ?? "").trim();
  if (search.length > 200) throw new Error("Search must be 200 characters or fewer");
  if (args.cefrLevel && !CEFR_LEVELS.includes(args.cefrLevel as any)) throw new Error("Invalid CEFR level");
  const match: any = {};
  if (search) {
    const regex = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.$or = [{ [`mainDocs.${field}`]: { $regex: regex, $options: "i" } }, { [`translatedDocs.${field}`]: { $regex: regex, $options: "i" } }];
  }
  if (args.cefrLevel) match["translatedDocs.cefrLevel"] = args.cefrLevel;
  return [
    { $lookup: { from: mainCollection, localField: "main", foreignField: "_id", as: "mainDocs" } },
    { $lookup: { from: translatedCollection, localField: "translated", foreignField: "_id", as: "translatedDocs" } },
    { $match: match }, { $sort: { [`translatedDocs.${field}`]: 1, _id: 1 } }, { $skip: offset }, { $limit: limit },
  ];
}
