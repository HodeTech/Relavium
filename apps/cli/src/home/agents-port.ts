import type { AgentDefinition } from '@relavium/core';

import { buildAgentsModel, type AgentsModel } from '../history/agents-model.js';
import { discoverAgentDefinitions } from '../workflows/catalog.js';

/**
 * What the Home's `/agents` Defined list reads, over the project the Home is in
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3, MVP-8 step 5).
 * It is thin, like `defined-port.ts`: the rows are {@link buildAgentsModel} over the project's agent catalog, read through the SAME
 * hardened catalog read `relavium list` and `chat --agent` resolve against, so the list shows exactly the agents those would find.
 */

/** The agents list as read now: the rows, and the id and path each row's `entryIndex` stands for. */
export interface AgentsRead {
  readonly model: AgentsModel;
  /** The id of the catalog entry a row's `entryIndex` names (an agent's id, or the file stem of a refused file); `undefined` when none sits there. */
  readonly slugOf: (entryIndex: number) => string | undefined;
  /** The catalog path of that same entry, as the catalog read it (the raw path, not the row's sanitized label); `undefined` when none sits there. */
  readonly pathOf: (entryIndex: number) => string | undefined;
  /**
   * The parsed definition the catalog read for that same entry (the whole of it, not the page's scrubbed text); `undefined` for a file that did
   * not parse and when none sits there. The page is drawn from it, so a `c` compares what it reads then with this: what the person read is
   * what is bound, or nothing is.
   */
  readonly definitionOf: (entryIndex: number) => AgentDefinition | undefined;
}

/** The agents list's read, behind a port so the browser is testable without a project. May throw a `CliError` (an unreadable or over-large catalog directory). */
export interface AgentsPort {
  readonly read: () => AgentsRead;
}

export interface AgentsPortOptions {
  /**
   * The project's `.relavium/` directory, or a function that finds it afresh on every read (as `createProjectCatalog` does: a `.relavium/`
   * that `/init` made in this very Home is seen without a restart). `undefined` ⇒ no project, so no agents.
   */
  readonly projectConfigDir: string | undefined | (() => string | undefined);
  /** The directory the catalog's relative paths are labelled against. */
  readonly cwd: string;
  /** The operator home the project-artifact rule reads; the Home's own, so nothing falls back to the process's. */
  readonly homeDir: string;
}

/** The agents list of the project: its catalog read now, every time, as rows that name their entries by index. */
export function createAgentsPort(options: AgentsPortOptions): AgentsPort {
  const { cwd, homeDir } = options;
  const configDir = (): string | undefined =>
    typeof options.projectConfigDir === 'function'
      ? options.projectConfigDir()
      : options.projectConfigDir;
  return {
    read: () => {
      const projectConfigDir = configDir();
      const items =
        projectConfigDir === undefined
          ? []
          : discoverAgentDefinitions({ projectConfigDir, cwd, homeDir });
      const model = buildAgentsModel(items);
      // The items are held by the read, so a row's index names the entry that was listed and not whatever sits there later.
      return {
        model,
        slugOf: (entryIndex) => items[entryIndex]?.entry.slug,
        pathOf: (entryIndex) => items[entryIndex]?.entry.path,
        definitionOf: (entryIndex) => items[entryIndex]?.agent,
      };
    },
  };
}
