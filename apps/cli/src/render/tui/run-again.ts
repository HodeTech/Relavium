import type { RunDetailRead } from '../../history/run-detail-source.js';
import type { DefinedPort, DefinedRead } from '../../history/defined-model.js';

/**
 * `r` on a run's detail ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6, MVP-11 unit 7): which workflow of THIS directory's catalog a finished run's workflow is, or the one honest line that says why it is
 * none. PURE, and it asks for nothing but two facts the detail already read (where the run was started, as a closed word, and the slug it was
 * recorded under) and the catalog the Defined tab reads. It cannot read a run's inputs (ADR-0113: not shown, not reused): the form asks them
 * again, and nothing starts without the form's own confirmation, which is the launch flow's and not this module's.
 *
 * The answer is what the Defined tab's own `r` asks the Home for: the catalog entry's slug and the path it was listed from, so the launch
 * flow refuses a slug whose file is another one by the time of the press (`launchMoved`). Every refusal is a closed sentence: no stored text
 * (the run's slug, a project path, a parse error of the file) is ever in one.
 *
 * **Offered is what would pass** ({@link runAgainOffered}): the legend names `[r] run again` only where {@link decideRunAgain} answers `run`
 * against the catalog read as the detail landed, so the key never promises what its press then refuses (a refusal is only what changed since).
 *
 * **A workflow that changed since the run is said, not refused** (round 2, security): the run froze its workflow (`authoredNodeCount`, the
 * nodes the snapshot lists) and the catalog entry that holds the slug now has its own count; when the two differ the request is still made, and
 * it carries `changed`, so the tab says {@link RUN_AGAIN_CHANGED} on its message row. The figure is all the detail has without another read of
 * the log, so an edit that keeps the number of nodes is not seen: the form shows the file as it is now, and the start is bound to that text.
 */

/** The run was started in another directory: this Home runs only the workflows of the directory it is in. */
export const RUN_AGAIN_OTHER_DIRECTORY = 'That run was started in another directory.';
/** The run recorded no directory, or the detail was not told where this Home is: unknown is never "here". */
export const RUN_AGAIN_DIRECTORY_UNKNOWN = 'The directory of that run is not known.';
/**
 * No entry of this directory's catalog has the slug the run recorded: the workflow was deleted or renamed, or the run was an ad-hoc file that
 * was never in `.relavium/workflows`, so the line does not claim it ever was.
 */
export const RUN_AGAIN_NOT_DEFINED = 'This workflow is not defined in this project.';
/** The catalog entry that holds the slug does not have the nodes the run froze: the form opens all the same, on the file as it is now. */
export const RUN_AGAIN_CHANGED = 'This workflow changed since that run.';
/** The catalog has the entry, and its file does not parse now. The parse error is the file's text and is not repeated. */
export const RUN_AGAIN_FILE_INVALID = 'The file of this workflow could not be read.';
/** There is no catalog to look in, or reading it failed. */
export const RUN_AGAIN_UNLISTED = 'The workflows of this project could not be listed.';

/**
 * The most catalog entries looked at. The catalog holds at most 500 files (`MAX_CATALOG_FILES`) and the scan ends at the first index that
 * names none, so this is only the bound of a port that never says so.
 */
const ENTRY_SCAN_MAX = 1024;

/**
 * What `r` comes to: the launch flow's own request (slug and the path it was listed from; `changed` only when the workflow is not the one the
 * run froze), or the line that says why there is none.
 */
export type RunAgainDecision =
  | {
      readonly kind: 'run';
      readonly slug: string;
      readonly path: string;
      readonly changed?: true;
    }
  | { readonly kind: 'refused'; readonly message: string };

function refused(message: string): RunAgainDecision {
  return { kind: 'refused', message };
}

/** The index of the catalog entry that carries `slug`, or `undefined`: every entry is looked at, the ones the Defined tab's rows were cut before too. */
function entryIndexOf(read: DefinedRead, slug: string): number | undefined {
  for (let index = 0; index < ENTRY_SCAN_MAX; index += 1) {
    const entry = read.slugOf(index);
    if (entry === undefined) return undefined;
    if (entry === slug) return index;
  }
  return undefined;
}

/** The catalog read now, or `undefined` when there is no catalog or it cannot be read (the fault is not repeated: it may carry a path). */
function readCatalog(defined: DefinedPort | undefined): DefinedRead | undefined {
  if (defined === undefined) return undefined;
  try {
    return defined.read();
  } catch {
    return undefined;
  }
}

/**
 * `r` on a run's detail: the workflow to run again, or why none. The directory is judged first (the run's own fact, so the catalog is not
 * read for it), then the workflow: the slug the run recorded must still be an entry of this directory's catalog, matched exactly, and its
 * file must parse. Whether the launch flow can open now (a leg already runs, no flow is wired) is the host's own refusal, said on the
 * same row by the host.
 */
export function decideRunAgain(
  read: RunDetailRead,
  defined: DefinedPort | undefined,
): RunAgainDecision {
  if (read.directory === 'elsewhere') return refused(RUN_AGAIN_OTHER_DIRECTORY);
  if (read.directory !== 'here') return refused(RUN_AGAIN_DIRECTORY_UNKNOWN);
  const slug = read.workflowSlug;
  if (slug === undefined) return refused(RUN_AGAIN_NOT_DEFINED);
  const catalog = readCatalog(defined);
  if (catalog === undefined) return refused(RUN_AGAIN_UNLISTED);
  const index = entryIndexOf(catalog, slug);
  const path = index === undefined ? undefined : catalog.pathOf(index);
  if (index === undefined || path === undefined) return refused(RUN_AGAIN_NOT_DEFINED);
  // The rows are bounded and an entry past them has none: the launch flow's own check then decides (it offers only a valid workflow).
  const row = catalog.model.rows.find((candidate) => candidate.entryIndex === index);
  if (row !== undefined && row.state !== 'ready') return refused(RUN_AGAIN_FILE_INVALID);
  const frozen = read.authoredNodeCount;
  const changed = frozen !== undefined && row?.nodeCount !== undefined && row.nodeCount !== frozen;
  return changed ? { kind: 'run', slug, path, changed: true } : { kind: 'run', slug, path };
}

/**
 * Whether the legend names `[r] run again` for this detail: exactly when {@link decideRunAgain} answers `run` against the catalog as it is now
 * (the host asks as the detail lands, once). A run of another directory, one with no recorded directory, a workflow the catalog does not have
 * and a file that does not parse are not offered it: `r` there still answers, with the line that says why, so the key is never silent.
 */
export function runAgainOffered(read: RunDetailRead, defined: DefinedPort | undefined): boolean {
  return decideRunAgain(read, defined).kind === 'run';
}
