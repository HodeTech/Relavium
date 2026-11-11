/** Keep auxiliary Ink/Yoga layout finite while raw transcript geometry is suspended. */
export function layoutColumns(columns: number): number {
  return Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 80;
}
