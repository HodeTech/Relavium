/** Submit-time guidance only. A suggestion never becomes an executable action. */
export function nearestCommandName(input: string, names: readonly string[]): string | undefined {
  if (input.length === 0 || input.length > 64 || names.includes(input)) return undefined;
  let nearest: string | undefined;
  let best = 3;
  for (const name of names) {
    if (Math.abs(name.length - input.length) >= best) continue;
    let row = Array.from({ length: name.length + 1 }, (_, index) => index);
    for (let at = 0; at < input.length; at++) {
      const next = [at + 1];
      for (let column = 0; column < name.length; column++)
        next.push(
          Math.min(
            (next[column] ?? 0) + 1,
            (row[column + 1] ?? 0) + 1,
            (row[column] ?? 0) + (input[at] === name[column] ? 0 : 1),
          ),
        );
      row = next;
    }
    const distance = row[name.length] ?? best;
    if (distance < best) {
      nearest = name;
      best = distance;
    }
  }
  return nearest;
}
