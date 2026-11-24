import {
  availabilityOf,
  commandsOf,
  placementOf,
  type AvailabilityContext,
  type CommandGroup,
  type PaletteSurface,
  type ReplCommand,
} from '../../commands/repl-commands.js';

/**
 * The rows of the `/` palette, built from the command registry ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §7, MVP-11 Step 2.2). Pure and framework-free: a host fills an {@link AvailabilityContext} from cached state, calls
 * {@link buildPaletteEntries} once, and the key fold ({@link foldPaletteKey}) and the view ({@link PaletteView}) both read the SAME rows, so
 * they cannot disagree on which row is highlighted.
 */

/** One row of the palette: a command as the surface offers it, in the order the registry declares, with whether it can act now. */
export interface PaletteEntry {
  readonly command: ReplCommand;
  /** The surface's own words for the command (`/exit` says where it goes). */
  readonly description: string;
  readonly group: CommandGroup;
  /** The first row of a group (and of the list): the view puts a blank row before it when the rows allow. */
  readonly groupStart: boolean;
  /** `false` ⇒ shown dim, with {@link reason}, skipped by the arrow keys and answered with the reason on `Enter`. */
  readonly enabled: boolean;
  /** Why a dim row cannot act, in words (`no conversation to clear`). Present exactly when {@link enabled} is `false`. */
  readonly reason?: string;
}

/** What a host knows when it builds the rows: everything but the surface, which is the other argument. An unknown field reads as enabled. */
export type PaletteContext = Readonly<Partial<AvailabilityContext>>;

/**
 * The palette's rows for a surface, in the registry's declared order: its groups in order, each by rank. With no provider key the Home's
 * `/providers` is the FIRST row of the whole list, before its group, because connecting a provider is the Home's primary action then.
 * `groupStart` is derived from the final order, so the lead is a group of its own and the rest of its group starts again after the others.
 */
export function buildPaletteEntries(
  surface: PaletteSurface,
  ctx: PaletteContext,
): readonly PaletteEntry[] {
  const context = { ...ctx, surface };
  const built = commandsOf(surface).flatMap((command) => {
    const placement = placementOf(command.name, surface);
    if (placement === undefined) return [];
    const availability = availabilityOf(command.name, surface, context);
    return [
      {
        command,
        description: placement.description,
        group: placement.group,
        enabled: availability.enabled,
        ...(availability.enabled ? {} : { reason: availability.reason }),
      },
    ];
  });
  const lead =
    surface === 'home' && context.hasKey === false
      ? built.findIndex((entry) => entry.command.name === 'providers')
      : -1;
  const ordered =
    lead > 0
      ? [...built.slice(lead, lead + 1), ...built.slice(0, lead), ...built.slice(lead + 1)]
      : built;
  return ordered.map((entry, index) => ({
    ...entry,
    groupStart: index === 0 || ordered[index - 1]?.group !== entry.group,
  }));
}

/** The entries that end a session or spend tokens: inside a tier of a typed query they come after the others. */
const LAST_IN_TIER: ReadonlySet<string> = new Set(['clear', 'cancel', 'compact', 'exit']);

/**
 * How well an entry matches a (trimmed, lower-cased) query, best first, or `undefined` when it does not match: 0 the name IS the query,
 * 1 the name starts with it, 2 the name holds it, 3 the shown description holds it.
 */
function matchTier(entry: PaletteEntry, q: string): number | undefined {
  const name = entry.command.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (entry.description.toLowerCase().includes(q)) return 3;
  return undefined;
}

/** Whether the name an entry carries is exactly what was typed (case-insensitively, whitespace around it ignored). */
export function isExactNameMatch(entry: PaletteEntry, query: string): boolean {
  return entry.command.name.toLowerCase() === query.trim().toLowerCase();
}

/**
 * The entries a typed query leaves, ranked (ADR-0145 §7.6): the name that equals the query, the names that start with it, the names that
 * hold it, then the descriptions that hold it, each tier in the declared order. Inside a tier the commands that end a session or spend tokens
 * (`clear`, `cancel`, `compact`, `exit`) come AFTER the others, so a short query never lands on one of them first. Case-insensitive, on a
 * name or the description the row shows. A ranked list is not a grouped one, so no row of it starts a group; an empty query leaves the list
 * as it is, groups and all.
 */
export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
): readonly PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return entries;
  const first: PaletteEntry[][] = [[], [], [], []];
  const last: PaletteEntry[][] = [[], [], [], []];
  for (const entry of entries) {
    const tier = matchTier(entry, q);
    if (tier === undefined) continue;
    (LAST_IN_TIER.has(entry.command.name) ? last : first)[tier]?.push({
      ...entry,
      groupStart: false,
    });
  }
  return first.flatMap((tier, index) => [...tier, ...(last[index] ?? [])]);
}

/** The index of the first row that can act, or `0` when none can (an all-dim list still has a highlighted row, which only explains itself). */
export function firstEnabledIndex(rows: readonly PaletteEntry[]): number {
  const index = rows.findIndex((entry) => entry.enabled);
  return index < 0 ? 0 : index;
}

/** The index of the last row that can act, or `0` when none can. */
export function lastEnabledIndex(rows: readonly PaletteEntry[]): number {
  const index = rows.findLastIndex((entry) => entry.enabled);
  return index < 0 ? 0 : index;
}
