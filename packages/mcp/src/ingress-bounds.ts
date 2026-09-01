import { utf8ByteLength } from '@relavium/shared';

/**
 * The ingress bounds on what an MCP server may hand us
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §5, `CR-42`, `G33`, `#201`,
 * `#209`, `#288`).
 *
 * **The gap was measured, not inferred.** `collectAllTools` bounded the number of `tools/list` PAGES and
 * nothing else, so a server returning 100 pages of 500 tools with 1 MiB descriptions was admitted whole:
 * **50 000 tools, 52 GB of description text, zero skipped** — and that text is re-sent to the provider on
 * every subsequent turn of the session. The schema compiler had been hardened against a hostile `inputSchema`
 * since 2.R; the surrounding discovery pipeline had no budget at all, which is the asymmetry this closes.
 *
 * **Two levels, two different guarantees, and ADR-0088 §5.1 keeps them apart deliberately.** These are
 * APPLICATION-level bounds: they run on an already-parsed value, so they bound what is ADMITTED — what
 * reaches the prompt, the state and the registry — and **not** what was allocated to get there. The
 * transport-level bound that actually caps peak memory lives where raw bytes are visible, which is only the
 * injected `fetch` of `http`/`sse`. Claiming these prevent an OOM would be false; `stdio` and a local
 * `websocket` have only this level, and their memory story is the consent gate's (§6).
 */

/**
 * The seven numbers, in one object for the same reason `ADMISSION_CEILINGS` is: a caller that wants to show
 * them should not have to know seven identifier names.
 *
 * Chosen so every real MCP server in circulation clears them several times over — catalogues run 5–50 tools
 * with 0.2–2 KiB descriptions — while the measured server above is refused.
 */
export const INGRESS_BOUNDS = {
  /** Tools admitted from one server, across ALL `tools/list` pages. */
  toolsPerServer: 256,
  /** One tool's `description`, in UTF-8 bytes. */
  toolDescriptionBytes: 8 * 1024,
  /** One server's whole discovery payload — names + descriptions + schemas — in UTF-8 bytes. */
  discoveryBytesPerServer: 1024 * 1024,
  /** One string literal or `enum` member inside a schema. */
  schemaStringBytes: 4 * 1024,
  /** One schema property name. */
  schemaPropertyNameBytes: 256,
  /** One `tools/call` result's text, summed across its content parts. */
  toolResultTextBytes: 1024 * 1024,
  /** One message on an `http`/`sse` transport — the only place raw bytes are ours to count. */
  transportMessageBytes: 4 * 1024 * 1024,
} as const;

/**
 * The UTF-8 byte length of a value's canonical JSON form — the shape that actually travels.
 *
 * **Normative, because "8 KiB" is otherwise three different numbers**: a UTF-16 `.length`, a
 * `Buffer.byteLength`, and this. `utf8ByteLength` is the one shared unit (it moved to `@relavium/shared` for
 * exactly this reason), and a schema is measured as its serialization rather than by walking it, because the
 * serialization is what reaches the provider.
 *
 * An unserialisable value counts as 0 rather than throwing: a schema that cannot be serialised is refused by
 * the compiler on its own terms, and a size check is not the place to discover it.
 */
export function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8ByteLength(json);
  } catch {
    return 0;
  }
}

/** UTF-8 bytes of a string — re-exported so a caller measuring text does not reach past this module. */
export { utf8ByteLength };

/**
 * A running budget for ONE server's discovery walk.
 *
 * Stateful because the aggregate bound is the point: 256 tools at 8 KiB each is already 2 MiB before a single
 * schema is counted, so per-item bounds alone do not bound the total. `admit` is called in **declaration
 * order** as tools are shaped, and once it refuses, it keeps refusing — the caller stops paging.
 */
export class DiscoveryBudget {
  #tools = 0;
  #bytes = 0;
  #exhausted = false;

  /** Has the budget been spent? Once true it stays true — see {@link admit}. */
  get exhausted(): boolean {
    return this.#exhausted;
  }

  /** Tools admitted so far — for the diagnostic a host surfaces when it refused some. */
  get admitted(): number {
    return this.#tools;
  }

  /**
   * Charge one tool against the budget, returning why it was refused or `undefined` if it fits.
   *
   * **Fail-closed and ORDER-STABLE**: the first tool that would cross the aggregate exhausts the budget, and
   * every tool after it is refused too rather than being admitted because it happened to be smaller. A budget
   * that admitted a prefix "where it fits" would give a different tool set depending on which page arrived
   * first — the same server, two different agents, from one hostile catalogue.
   */
  admit(bytes: number): string | undefined {
    if (this.#exhausted) {
      return `the server's discovery budget was already exhausted (${INGRESS_BOUNDS.discoveryBytesPerServer} bytes / ${INGRESS_BOUNDS.toolsPerServer} tools)`;
    }
    if (this.#tools >= INGRESS_BOUNDS.toolsPerServer) {
      this.#exhausted = true;
      return `the server declares more than the maximum of ${INGRESS_BOUNDS.toolsPerServer} tools`;
    }
    if (this.#bytes + bytes > INGRESS_BOUNDS.discoveryBytesPerServer) {
      this.#exhausted = true;
      return `the server's tool definitions exceed the maximum of ${INGRESS_BOUNDS.discoveryBytesPerServer} bytes`;
    }
    this.#tools += 1;
    this.#bytes += bytes;
    return undefined;
  }
}

/**
 * Measure one discovered tool's contribution to the discovery budget: its name, its description, and the
 * serialized schema a provider will actually receive.
 */
export function toolDefinitionBytes(tool: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
}): number {
  return (
    utf8ByteLength(tool.name) +
    utf8ByteLength(tool.description ?? '') +
    jsonByteLength(tool.inputSchema)
  );
}

/**
 * Why a tool's own text is over-bound, or `undefined` when it fits.
 *
 * Separate from the budget because this refuses ONE tool without exhausting anything: a single enormous
 * description is a bad tool, not a bad server, and the rest of the catalogue is still usable.
 */
export function overSizedDescription(text = ''): string | undefined {
  // **Short-circuit on UTF-16 LENGTH before counting bytes**, because this runs once per discovered tool and
  // a hostile catalogue is where it runs 50 000 times. Every UTF-16 unit is at least one UTF-8 byte, so
  // `length > limit` already proves the bound is exceeded — and the exact count on a 1 MiB string is O(n)
  // work a server can ask for at will. Measured: without this, refusing the 50 000-tool × 1 MiB catalogue
  // took 52 GB of scanning and timed out its own regression test once the loop stopped breaking early.
  if (text.length > INGRESS_BOUNDS.toolDescriptionBytes) {
    return `description is over ${INGRESS_BOUNDS.toolDescriptionBytes} bytes, above the limit`;
  }
  const bytes = utf8ByteLength(text);
  return bytes > INGRESS_BOUNDS.toolDescriptionBytes
    ? `description is ${bytes} bytes, above the limit of ${INGRESS_BOUNDS.toolDescriptionBytes}`
    : undefined;
}
