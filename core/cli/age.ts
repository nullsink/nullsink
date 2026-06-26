// Compact "age" rendering for `nsk orders`: a millisecond span → a short human string ("45s", "12m",
// "3h20m", "2d4h"), the magnitude picking the unit. Pure and DB-free so it unit-tests on its own (the rest of
// cli/orders.ts opens the orders store on import). A negative span — clock skew between a row's created_at and
// now — clamps to "0s" rather than emitting "-5s".
export function formatAge(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin % 60;
    return m ? `${totalHr}h${m}m` : `${totalHr}h`;
  }
  const d = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return h ? `${d}d${h}h` : `${d}d`;
}
