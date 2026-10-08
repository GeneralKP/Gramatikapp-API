import { getNamedType, isObjectType, type GraphQLResolveInfo, type FieldNode } from 'graphql';
import { collectSubfields } from 'graphql/execution/collectFields.js';

// Use GraphQL's own collection rules so aliases, fragments and @skip/@include
// have the same meaning for database projection and response execution.
export function selectedFields(info: GraphQLResolveInfo, type = getNamedType(info.returnType), nodes: readonly FieldNode[] = info.fieldNodes) {
  if (!isObjectType(type)) return new Map<string, readonly FieldNode[]>();
  return collectSubfields(info.schema, info.fragments, info.variableValues, type, nodes);
}

export function catalogProjection(info?: GraphQLResolveInfo, reviewedWords = false): Record<string, number> | undefined {
  if (!info) return undefined;
  const relation = getNamedType(info.returnType);
  if (!isObjectType(relation)) return undefined;
  const projection: Record<string, number> = { _id: 1, main: 1, translated: 1 };
  for (const nodes of selectedFields(info).values()) {
    const name = nodes[0].name.value;
    if (name === 'createdAt') projection.createdAt = 1;
    if (name !== 'main' && name !== 'translated') continue;
    const path = name === 'main' ? 'mainDocs' : 'translatedDocs';
    projection[`${path}._id`] = 1;
    for (const nested of selectedFields(info, getNamedType(relation.getFields()[name].type), nodes).values()) {
      const field = nested[0].name.value;
      if (reviewedWords && (['word', 'examples'].includes(field) || (name === 'translated' && ['notes', 'forms', 'gramaticalCategories'].includes(field)))) {
        for (const dependency of ['version', 'german', 'spanish', 'notes']) projection[`study.${dependency}`] = 1;
        if (name === 'translated' && field === 'forms') projection['study.forms'] = 1;
        if (name === 'translated' && field === 'gramaticalCategories') projection['study.category'] = 1;
        if (field === 'examples') projection[`study.${name === 'main' ? 'spanish' : 'german'}Examples`] = 1;
      }
      if (field === 'id' || field === '__typename' || field === 'failureIndex') continue;
      projection[`${path}.${field}`] = 1;
      if (field === 'level') projection[`${path}.cefrLevel`] = 1;
    }
  }
  return projection;
}
