/** Fold NTFS stream, case and trailing dot/space aliases for filesystem policy comparisons. */
export function foldPathComponent(name: string): string {
  const beforeStream = name.split(':', 1)[0] ?? name;
  const lowered = beforeStream.toLowerCase();
  // Scan backwards: a quantified suffix regex retries long failed prefixes quadratically.
  let end = lowered.length;
  while (end > 0 && (lowered[end - 1] === '.' || lowered[end - 1] === ' ')) end -= 1;
  return lowered.slice(0, end);
}
