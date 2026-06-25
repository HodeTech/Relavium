import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import {
  InMemoryRunStore,
  createInMemoryCheckpointer,
  type Checkpointer,
  type ExecutionHost,
  type RunStore,
} from '@relavium/core';
import {
  FilesystemMediaStore,
  createFilesystemMediaWrite,
  createMediaReferencePort,
  createMediaReferenceStore,
  fetchMediaBytes,
  type Db,
} from '@relavium/db';

/**
 * Host media-port roots the CLI resolves per-invocation and injects into {@link createCliHost} (2.S). Each is
 * optional + absent-tolerant: an unset root leaves its port `undefined`, and the engine fails the relevant
 * operation loud rather than leaking bytes. Passed in (never hard-coded) so the desktop/VS Code hosts reuse
 * the same seam with their own roots.
 */
export interface CliMediaOptions {
  /**
   * The `save_to` write-port scope root the CALLER resolves and passes — the `run`/`gate` paths pass
   * `<cwd>/.relavium/runs/` (project-relative). The port `realpath`+`commonpath`-jails every write under it
   * (symlinks off, ADR-0044 §2). Absent ⇒ no `mediaWrite`, so an `output` node's `save_to` fails the run with
   * a clear configuration error (never a silent skip).
   */
  readonly saveToRoot?: string;
  /**
   * The content-addressed media-store (CAS) root the CALLER resolves and passes — the `run`/`gate` paths pass
   * `~/.relavium/media/` (global, sha256-addressed, deduped across runs).
   * Backs `ExecutionHost.mediaStore` — the de-inline/persist choke point the engine writes produced media to,
   * and the same instance the `AgentRunnerDeps.resolveForEgress` re-materialization reads (a handle written by
   * one resolves in the other). Absent ⇒ no `mediaStore`, so a media-PRODUCING run fails `media_store_unavailable`.
   */
  readonly casRoot?: string;
  /**
   * The SQLite connection backing the `media_objects`/`media_references` retention + authz junction (2.S reuses
   * the 2.H `history.db`). Wires `ExecutionHost.mediaReferences` so the engine records a produced handle's run
   * reference at the de-inline choke point and reclaims them at the run's terminal event. Absent ⇒ no port
   * (best-effort retention only; never a run-correctness break).
   */
  readonly referenceDb?: Db;
}

/** Options for {@link createCliHost}. */
export interface CliHostOptions {
  /**
   * The {@link Checkpointer} the engine's `resumeFromCheckpoint` loads from — supplied only on the
   * cross-process gate-resume path (**2.G**), where it must reconstruct from the durable event log (the
   * `createHistoryCheckpointer` over the SQLite store). Omitted on the `run` path, which never resumes from a
   * checkpoint, so it defaults to the in-memory reconstruction (a no-op `undefined` over the durable store).
   *
   * MUST be paired with an explicit **durable** `store` reconstructed from the SAME backend — the engine reads
   * the checkpoint from here but resolves/persists through `host.store`, so a checkpointer over the default
   * in-memory store is a split-backend wiring bug that `createCliHost` rejects at construction.
   */
  readonly checkpointer?: Checkpointer;
  /** The media-port roots (2.S) — see {@link CliMediaOptions}. Absent ⇒ a media-producing run fails loud. */
  readonly media?: CliMediaOptions;
}

/**
 * Wire the `save_to` write port, provisioning its jail root LAZILY — on the first actual write, not at host
 * construction. The port itself fail-closes when the root is missing (`createFilesystemMediaWrite` `realpath`s it
 * on every write, ADR-0044 §2) and never creates it — so it can't be coerced into materializing an arbitrary
 * directory; provisioning is the HOST's job. A fresh `relavium run` in a project that has never produced media has
 * no `<cwd>/.relavium/runs/` yet, and the first `save_to` deliverable must land, not fail the run. Doing the
 * `mkdir` on EVERY write (rather than eagerly in `createCliHost`) keeps a run WITHOUT any `save_to` from
 * requiring cwd write access — durable runs in a read-only environment don't fail at host construction. The
 * async `mkdir(recursive)` is idempotent (a ~no-op once the root exists) and runs before
 * `createFilesystemMediaWrite`'s `realpath` jail; the await keeps the port fully non-blocking (matching the
 * `node:fs/promises` pattern `FilesystemMediaStore.put` uses). The CAS root is NOT provisioned here — `FilesystemMediaStore` lazily `mkdir`s its sharded path
 * on `put`.
 */
function wireSaveToPort(saveToRoot: string): ReturnType<typeof createFilesystemMediaWrite> {
  const write = createFilesystemMediaWrite(saveToRoot);
  return async (relativePath, bytes, signal) => {
    await mkdir(saveToRoot, { recursive: true });
    return write(relativePath, bytes, signal);
  };
}

/**
 * A real, node-backed {@link ExecutionHost} for the CLI — wall-clock ISO timestamps, UUID ids
 * (ADR-0022), `setTimeout` one-shot timers, and the global AbortController. `run` injects the durable
 * SQLite `RunStore` (2.H); `gate` additionally injects the durable {@link Checkpointer} (2.G) so a fresh
 * process can rehydrate a paused run from its persisted events. The media ports (**2.S**) wire when their
 * config is given: `fetchMedia` (SSRF-validated egress, ADR-0043) is always on; `mediaStore` (the CAS
 * de-inline/persist choke point), `mediaReferences` (the retention/authz junction), and `mediaWrite` (the
 * `save_to` write port) wire from `media.casRoot` / `media.referenceDb` / `media.saveToRoot`. A media-PRODUCING
 * run with no `mediaStore` fails loud (`media_store_unavailable`), never a silent byte leak. (`read_media`
 * input access is a session feature — deferred to 2.M, so it stays fail-closed unavailable on the `run` path.)
 *
 * The clock/ids/abort/timer + the media ports are generic Node primitives (no CLI specifics), so this is
 * positioned for later extraction to a shared node-host helper the VS Code host can reuse.
 */
export function createCliHost(
  store: RunStore = new InMemoryRunStore(),
  options?: CliHostOptions,
): ExecutionHost {
  // A durable checkpointer reads from one backend (the persisted event log) while the host's `store` does the
  // resolveWorkflowId / persistEvent writes; if `store` is the in-memory reference (incl. the default), the two
  // point at DIFFERENT backends and `resumeFromCheckpoint` would validate/persist against the wrong store. Fail
  // loud at wiring time — the only valid pairing is a durable `store` + a checkpointer reconstructed from it.
  if (options?.checkpointer !== undefined && store instanceof InMemoryRunStore) {
    throw new Error(
      'createCliHost: a checkpointer requires an explicit durable RunStore (the checkpointer must reconstruct from the same store the run persists to)',
    );
  }
  // Construct each media port ONCE from its root/handle (a port is absent when its config is). The single
  // `FilesystemMediaStore` instance is THE store `host.mediaStore` exposes and `resolveForEgress` reads — a
  // handle put by the de-inline choke point must resolve in the failover re-materialization (one CAS, ADR-0042).
  const media = options?.media;
  const mediaStore =
    media?.casRoot === undefined ? undefined : new FilesystemMediaStore(media.casRoot);
  const mediaReferences =
    media?.referenceDb === undefined
      ? undefined
      : createMediaReferencePort(createMediaReferenceStore(media.referenceDb));
  const mediaWrite = media?.saveToRoot === undefined ? undefined : wireSaveToPort(media.saveToRoot);
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { newId: () => randomUUID() },
    store,
    checkpointer: options?.checkpointer ?? createInMemoryCheckpointer(store),
    // A NATIVE AbortController — its `signal` is a real `AbortSignal` that the provider SDKs thread into
    // `fetch`, so a run cancel actually aborts an in-flight LLM stream (→ prompt `run:cancelled`). The
    // engine's in-house `createAbortController` is for TESTS ONLY (its signal is not `instanceof
    // AbortSignal`, so adapters drop it and a Ctrl-C can't interrupt a live stream). See execution-host.ts.
    newAbortController: () => new AbortController(),
    setTimer: (ms, onFire) => {
      const timer = setTimeout(onFire, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    // The host media-egress mechanism (1.AF/D9, ADR-0043): re-host a public-HTTPS `url` media source to a
    // handle via `@relavium/db`'s `fetchMediaBytes` — the SSRF-validated, size-bounded connect, canonically
    // homed there (see ADR-0043 §2-3 / the `media-egress.ts` header + its test suite). The wiring
    // rationale: `allowPrivate: false` is the default-deny posture (the BYOK local-endpoint opt-in is deferred,
    // security-review.md); the engine owns the `maxBytes` policy + the run `AbortSignal`; always wired (a
    // text-only run never invokes it); `signal` is spread conditionally so an absent one is OMITTED, not
    // assigned `undefined` (which `exactOptionalPropertyTypes` rejects).
    fetchMedia: (url, maxBytes, signal) =>
      fetchMediaBytes(url, {
        maxBytes,
        allowPrivate: false,
        ...(signal === undefined ? {} : { signal }),
      }),
    // The media ports (2.S), each spread in only when its config (above) was supplied — `undefined` is OMITTED,
    // not assigned (the host fields are `?:`, exactOptionalPropertyTypes). `mediaStore` (CAS de-inline/persist,
    // ADR-0042) + `mediaReferences` (retention/authz junction) + `mediaWrite` (`save_to` write port, ADR-0044
    // §2; realpath+commonpath jail, symlinks off — the engine resolves the `{{ run.id }}`-only template + the
    // produced handle's bytes and hands `(relativePath, bytes)` here). Absent `mediaStore` ⇒ a media-PRODUCING
    // run fails `media_store_unavailable` (never a silent byte leak); absent `mediaWrite` ⇒ a `save_to` fails
    // the run (never a silent skip — it is a real deliverable).
    ...(mediaStore === undefined ? {} : { mediaStore }),
    ...(mediaReferences === undefined ? {} : { mediaReferences }),
    ...(mediaWrite === undefined ? {} : { mediaWrite }),
  };
}
