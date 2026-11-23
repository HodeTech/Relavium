import type { Agent } from '@relavium/shared';

import type { CatalogEntry } from '../workflows/catalog.js';
import { scrubbedBounded } from './run-detail-model.js';

/**
 * The pure view model of the Home's `/agents` Defined list ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the agents the project declares on disk, one row per agent file, and for a valid agent the read-only detail
 * `Enter` opens. Nothing is read or written here. The caller reads the catalog (`discoverAgentDefinitions`) and hands each file's
 * entry and parsed definition in; every free-form string leaves through the one scrub-and-bound floor ({@link scrubbedBounded}).
 *
 * - **One row per file, in the catalog's own order** (by slug). A file that did not parse stays a row, `invalid`, with the catalog's
 *   reason and no detail: it is shown, never hidden. The reason is the catalog's own string: it names authored keys and field paths,
 *   not their values (the core parser's contract), and it is scrubbed and cut to 256 code points here like every other string.
 * - **The detail is a fixed list of fields** — the model, the provider, the tool grant as the definition declares it, the
 *   temperature and the reasoning effort — **plus the head of the system prompt** and nothing else of it. An agent file is repository-
 *   authored text (an imported or downloaded definition is exactly the case), so the head is scrubbed WHOLE first and cut only
 *   after ({@link scrubbedBounded}): a cut made first would leave the first half of a key the scrubber no longer recognises.
 * - **A row names its entry by index, not by its slug.** {@link AgentRow.slug} is a label; the id a chat is bound by is what the
 *   port's `slugOf` returns for the row's `entryIndex`, so every string of a row stays sanitized.
 */

/** The most code points of the system prompt the detail shows. A cut is marked with `…` (see {@link scrubbedBounded}). */
export const AGENT_PROMPT_HEAD_CHARS = 240;

/** The most tool names the detail lists; the rest are counted, not drawn. */
export const AGENT_TOOLS_MAX = 64;

/** The longest catalog file path or refusal reason a row shows, in code points. */
const MAX_DETAIL_CHARS = 256;

/** What a row says when the catalog marked a file valid but handed no definition: it is shown as unreadable, never as ready. */
const UNREADABLE = 'could not be read';

/** `ready`: an agent file that parsed. `invalid`: one that did not (shown, never hidden). */
export type AgentRowState = 'ready' | 'invalid';

/** The catalog fields a row reads. A {@link CatalogEntry} satisfies it. */
export type AgentEntry = Pick<CatalogEntry, 'slug' | 'name' | 'path' | 'valid' | 'error'>;

/** The definition fields the detail reads. An `AgentDefinition` satisfies it. */
export type AgentFields = Pick<
  Agent,
  'model' | 'provider' | 'system_prompt' | 'tools' | 'temperature' | 'reasoning_effort'
>;

/** One agent file as the model takes it: the catalog entry, and the parsed definition of a valid one. */
export interface AgentsModelItem {
  readonly entry: AgentEntry;
  readonly agent: AgentFields | undefined;
}

/** The read-only detail of a ready agent: only what the definition declares, sanitized and bounded. */
export interface AgentDetail {
  readonly model: string;
  readonly provider: string;
  /**
   * The tool names the definition declares, in its order, up to {@link AGENT_TOOLS_MAX}; empty when it declares none (an agent with no
   * `tools` is granted none by its definition). Each is a label: scrubbed and bounded, so an ordinary name is unchanged.
   */
  readonly tools: readonly string[];
  /** How many declared tools {@link AgentDetail.tools} leaves out. */
  readonly toolsMore: number;
  /** Present only when the definition sets one. */
  readonly temperature?: number;
  /** Present only when the definition sets one. */
  readonly reasoningEffort?: string;
  /**
   * The first {@link AGENT_PROMPT_HEAD_CHARS} code points of the system prompt, scrubbed whole and then cut, on one line; a `…`
   * marks a cut. A prompt of more than the scrub's input bound is not shown in part: a fixed sentence says its size.
   */
  readonly promptHead: string;
}

export interface AgentRow {
  readonly state: AgentRowState;
  /** The slug as a label: the agent's id, or the file's stem for a file that did not parse. Never a key and never a path. */
  readonly slug: string;
  /** Where the row's item sits in {@link buildAgentsModel}'s input: the key the port's `slugOf` and `pathOf` answer for. */
  readonly entryIndex: number;
  readonly name?: string;
  /** The catalog file the row was read from, as `discoverAgentDefinitions` returned it (sanitized, bounded). */
  readonly path: string;
  /** Why an `invalid` row is not ready; absent on a ready row. */
  readonly note?: string;
  /** Present exactly on a `ready` row. */
  readonly detail?: AgentDetail;
}

export interface AgentsModel {
  readonly rows: readonly AgentRow[];
  /** Every row there is: `rows.length`. */
  readonly total: number;
}

/**
 * The read-only detail of one definition: every free-form string through the one scrub-and-bound floor. Exported so the chat's bound-agent
 * sheet (`chat/bound-agent-view.ts`) shows a definition through the SAME function the `/agents` detail does: a second builder
 * would be a second scrub, and two screens could then mask one agent differently.
 */
export function agentDetailOf(agent: AgentFields): AgentDetail {
  const declared = agent.tools ?? [];
  const tools = declared.slice(0, AGENT_TOOLS_MAX).map((name) => scrubbedBounded(name));
  const { temperature, reasoning_effort: reasoningEffort } = agent;
  return {
    model: scrubbedBounded(agent.model),
    provider: scrubbedBounded(agent.provider),
    tools,
    toolsMore: declared.length - tools.length,
    ...(typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: scrubbedBounded(reasoningEffort) }),
    promptHead: scrubbedBounded(agent.system_prompt, AGENT_PROMPT_HEAD_CHARS),
  };
}

/** What a screen says of a definition that declares no tool: it is granted none by its definition. */
export const NO_TOOLS_DECLARED = 'none declared';

/** The tool grant as the definition declares it, as one string: the names the detail kept, then how many it left out. */
export function agentToolsText(detail: AgentDetail): string {
  if (detail.tools.length === 0 && detail.toolsMore === 0) return NO_TOOLS_DECLARED;
  const names = detail.tools.join(', ');
  return detail.toolsMore > 0
    ? `${names}${names === '' ? '' : ', '}… and ${String(detail.toolsMore)} more`
    : names;
}

function rowOf(item: AgentsModelItem, entryIndex: number): AgentRow {
  const { entry, agent } = item;
  const base = {
    slug: scrubbedBounded(entry.slug),
    entryIndex,
    ...(entry.name === undefined ? {} : { name: scrubbedBounded(entry.name) }),
    path: scrubbedBounded(entry.path, MAX_DETAIL_CHARS),
  };
  // A file is ready only with its definition in hand: a `valid` entry with none is refused, not shown as an agent with no detail.
  if (entry.valid && agent !== undefined) {
    return { state: 'ready', ...base, detail: agentDetailOf(agent) };
  }
  return {
    state: 'invalid',
    ...base,
    note: scrubbedBounded(entry.valid ? UNREADABLE : (entry.error ?? UNREADABLE), MAX_DETAIL_CHARS),
  };
}

/** The agents list: one row per agent file, in the order given (the catalog's, by slug), each ready one with its detail. */
export function buildAgentsModel(items: readonly AgentsModelItem[]): AgentsModel {
  const rows = items.map((item, index) => rowOf(item, index));
  return { rows, total: rows.length };
}
