/** MongoDB limit(0) is unbounded, so reject invalid public list bounds before a read. */
export function catalogListBounds(args: { limit?: number; offset?: number }, defaultLimit = 100) {
  const limit = args.limit === undefined ? defaultLimit : args.limit;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Choose a catalog limit from 1 to 500.");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Choose a non-negative catalog offset.");
  return { limit, offset };
}
