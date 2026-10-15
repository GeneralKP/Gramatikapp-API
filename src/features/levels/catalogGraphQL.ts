import type { ObjectId } from "mongodb";

interface CatalogDocument {
  _id: ObjectId;
  createdAt?: Date;
}

/** Catalog selections keep identity but may project away every other field. */
export type ProjectedCatalogDocument<T extends CatalogDocument> = Pick<T, "_id"> & Partial<Omit<T, "_id">>;

export type GraphQLCatalogDocument<T extends CatalogDocument> = Omit<T, "createdAt"> & {
  id: string;
  createdAt: string | undefined;
};

export interface JoinedCatalogDocuments<T extends CatalogDocument> {
  mainDocs?: T[] | null;
  translatedDocs?: T[] | null;
  mainDoc?: T | null;
  translatedDoc?: T | null;
}

export function toGraphQLDocument<T extends CatalogDocument>(
  document: T | null | undefined,
): GraphQLCatalogDocument<T> | null {
  if (!document) return null;
  return {
    ...document,
    id: document._id.toString(),
    createdAt: document.createdAt?.toISOString(),
  };
}

/** Preserve existing cached slots when a lookup array is empty or absent. */
export function toGraphQLRelation<T extends CatalogDocument & JoinedCatalogDocuments<CatalogDocument>>(
  relation: T,
): GraphQLCatalogDocument<T> {
  const document = { ...relation };
  if (relation.mainDocs && relation.mainDocs.length > 0) document.mainDoc = relation.mainDocs[0];
  if (relation.translatedDocs && relation.translatedDocs.length > 0) document.translatedDoc = relation.translatedDocs[0];
  return toGraphQLDocument(document);
}
