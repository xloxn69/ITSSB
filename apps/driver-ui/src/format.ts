/** "just now", "42 s ago", "3 min ago", "2 h ago". Never rounds an old age down to "now". */
export function formatAge(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 2) return "just now";
  if (s < 120) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
