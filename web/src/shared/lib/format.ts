/** "2m 05s", "1h 02m" for call lengths. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

/** Compact relative time ("now", "5m", "3h", "2d") with a locale date fallback after a week. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (diff < 45) return 'now';
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h`;
  if (diff < 7 * 86_400) return `${Math.round(diff / 86_400)}d`;
  return new Date(iso).toLocaleDateString();
}
