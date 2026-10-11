/** Shared web/native labels. Equal schedules remain equal; rounding must not hide distinct choices. */
export function formatReviewDelay(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  const days = seconds / 86400;
  if (days > 360) return `${Number((days / 365).toFixed(1))}y`;
  if (days > 30) return `${Number((days / 30).toFixed(1))}mo`;
  return `${Math.round(days)}d`;
}

export function reviewDelayLabels(options: { grade: string; delaySeconds: number }[]): Record<string, string> {
  const groups = new Map<string, Set<number>>();
  for (const option of options) {
    const label = formatReviewDelay(option.delaySeconds);
    const group = groups.get(label) ?? new Set<number>();
    group.add(option.delaySeconds);
    groups.set(label, group);
  }
  return Object.fromEntries(options.map(option => {
    const label = formatReviewDelay(option.delaySeconds);
    if (groups.get(label)!.size < 2) return [option.grade, label];
    const seconds = Math.max(1, Math.round(option.delaySeconds));
    // A colliding compact label falls back to exact days or mixed short units.
    const exact = seconds >= 86400 && seconds % 86400 === 0 ? `${seconds / 86400}d`
      : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`
      : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    return [option.grade, exact];
  }));
}
