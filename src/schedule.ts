/** Returns true when enough time has elapsed since `lastRunAt` to justify a new measurement. */
export function shouldMeasure(lastRunAt: string | null, nowMs: number, intervalMs: number): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  return Number.isNaN(last) || nowMs - last >= intervalMs;
}
