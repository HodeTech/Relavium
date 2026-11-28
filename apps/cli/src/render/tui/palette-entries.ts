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

/**
 * The entries that end a session or spend tokens. Inside a tier of a typed query they come after the others ({@link filterPaletteEntries}),
 * and a typed query that is not the start of one of their names never HIGHLIGHTS one ({@link bestMatchIndex}).
 */
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
function isExactNameMatch(entry: PaletteEntry, query: string): boolean {
  return entry.command.name.toLowerCase() === query.trim().toLowerCase();
}

/**
 * The entries a typed query leaves, ranked (ADR-0145 §7.6): the name that equals the query, the names that start with it, the names that
 * hold it, then the descriptions that hold it, each tier in the declared order. Inside a tier the commands that end a session or spend tokens
 * (`clear`, `cancel`, `compact`, `exit`) come AFTER the others. That ordering alone does not keep a short query off them (an end row that is
 * alone in a better tier still leads the list), so the highlight is chosen by {@link bestMatchIndex}. Case-insensitive, on a
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

/**
 * The commands whose row is never highlighted for a query that is not the start of their NAME: the ones that end a session or spend tokens
 * ({@link LAST_IN_TIER}) and `trim`, which drops the older messages for good. A description match is not a start of a name: `/res` reaches
 * `/clear` through its description, `/su` reaches `/compact`, `/ini` and `/sa` reach `/trim`, and `Enter` on a highlight is a run.
 */
const NEEDS_ITS_NAME: ReadonlySet<string> = new Set([...LAST_IN_TIER, 'trim']);

/** The index {@link bestMatchIndex} answers when no row may be highlighted: `Enter` then answers as it does for a query that matches nothing. */
export const NO_HIGHLIGHT = -1;

/**
 * The highlighted row after a typed query (ADR-0145 §7.6, round 2 A2: a short query does not land on `/clear`, `/cancel`, `/compact`, `/exit`
 * or `/trim`). Reordering inside a tier is not enough (`/e` has `/exit` alone in its tier, `/res` reaches `/clear` through its description),
 * so the choice is made here, in this order:
 *
 *  1. a typed EXACT name wins even when it is dim, so `Enter` explains it instead of running something else;
 *  2. the first row that can act and is not one of {@link NEEDS_ITS_NAME};
 *  3. when every row that can act is one of those: the first whose NAME the query starts (`/exi`, `/cle`, `/tri`); and when none is, NO row
 *     is highlighted ({@link NO_HIGHLIGHT}): `Enter` answers as it does for a query that matches nothing, and the typed line is dispatched,
 *     not dropped;
 *  4. when no row can act, the first row a query may land on, which only explains itself.
 *
 * Never a row of the end-and-spend set because its DESCRIPTION held the query.
 */
export function bestMatchIndex(rows: readonly PaletteEntry[], query: string): number {
  const first = rows[0];
  if (first !== undefined && isExactNameMatch(first, query)) return 0;
  if (rows.length === 0) return 0;
  const typed = query.trim().toLowerCase();
  const startsName = (entry: PaletteEntry): boolean =>
    entry.command.name.toLowerCase().startsWith(typed);
  const mayHighlight = (entry: PaletteEntry): boolean =>
    !NEEDS_ITS_NAME.has(entry.command.name) || startsName(entry);
  const safe = rows.findIndex((entry) => entry.enabled && !NEEDS_ITS_NAME.has(entry.command.name));
  if (safe >= 0) return safe;
  const named = rows.findIndex((entry) => entry.enabled && startsName(entry));
  if (named >= 0) return named;
  if (rows.some((entry) => entry.enabled)) return NO_HIGHLIGHT;
  const explaining = rows.findIndex(mayHighlight);
  return explaining >= 0 ? explaining : NO_HIGHLIGHT;
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
