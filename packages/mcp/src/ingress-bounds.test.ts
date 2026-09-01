import { describe, expect, it } from 'vitest';

import { McpError } from './errors.js';
import {
  DiscoveryBudget,
  INGRESS_BOUNDS,
  jsonByteLength,
  overSizedDescription,
  toolDefinitionBytes,
  utf8ByteLength,
} from './ingress-bounds.js';
import { shapeToolResult } from './result.js';
import { collectAllTools } from './sdk-stdio.js';
import { buildServerToolDefs } from './tool-mapping.js';

/**
 * `CR-42`'s ingress bounds ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §5).
 *
 * **The measurement this inverts.** Before these bounds, `collectAllTools` capped the number of `tools/list`
 * PAGES and nothing else, so a server returning 100 pages of 500 tools with 1 MiB descriptions was admitted
 * whole — **50 000 tools, 52 GB of description text, zero skipped** — and that text is re-sent to the
 * provider on every subsequent turn of the session. The first test below is that exact server.
 *
 * The bounds are APPLICATION-level: they bound what is admitted, not what was allocated to get there
 * (§5.1). Nothing here claims to prevent an OOM, and the tests are written not to imply it.
 */

const schema = { type: 'object', properties: {} } as const;
const tool = (
  name: string,
  description = '',
): Parameters<typeof buildServerToolDefs>[1][number] => ({
  name,
  description,
  inputSchema: schema,
});

describe('the hostile catalogue that was admitted whole', () => {
  it('refuses 50 000 tools with 1 MiB descriptions, and admits none of the overflow', async () => {
    // Deliberately the measured shape, not a minimal one: 100 pages × 500 tools, each with a 1 MiB
    // description. Every dimension that was unbounded is exercised at once.
    const perPage = 500;
    const huge = 'A'.repeat(1024 * 1024);
    let page = 0;
    const discovered = await collectAllTools(() => {
      page += 1;
      return Promise.resolve({
        tools: Array.from({ length: perPage }, (_, i) => ({
          name: `t${page}_${i}`,
          description: huge,
          inputSchema: schema,
        })),
        ...(page < 100 ? { nextCursor: String(page) } : {}),
      });
    });
    // **Paging STOPS at the aggregate bound** (§5.2: "dropped along with every tool after it, and paging
    // stops"). This line used to assert `toHaveLength(50_000)` — it contracted the exact behaviour the ADR
    // forbids, and made the "bound" a bound on what was admitted after fetching everything: 100 pages at up
    // to 4 MiB is ~400 MiB held on a remote transport, and `stdio` has no transport byte bound at all.
    expect(page).toBeLessThan(100); // it did not walk the catalogue to the end
    expect(discovered.length).toBeLessThan(50_000);

    // Admission is unchanged and still decides what is ADMITTED — the paging bound only stops asking for
    // pages no admission could use.
    const shaped = buildServerToolDefs('s', discovered);
    expect(shaped.defs).toHaveLength(0); // every one is over the description bound
    expect(shaped.skipped[0]?.reason).toMatch(/description is (over )?\d+ bytes/);
    // And the total actually admitted is bounded, which is the property the per-item bound alone lacks.
    const admittedBytes = shaped.defs.reduce((n, d) => n + utf8ByteLength(d.description), 0);
    expect(admittedBytes).toBeLessThanOrEqual(INGRESS_BOUNDS.discoveryBytesPerServer);
    // The DIAGNOSTIC is bounded too — a defect this very test surfaced by being slow. Bounding what is
    // admitted while leaving one skip entry per refused tool just moves the flood to stderr.
    expect(shaped.skipped.length).toBeLessThanOrEqual(INGRESS_BOUNDS.toolsPerServer + 1);
    // …and the cap is on what is SAID, never on what is examined. The first version broke the loop here,
    // which let a hostile server hide an allowlisted tool behind 257 decoys (see the allowlist test below).
    // The work is bounded instead by refusing an over-long description in O(1) — this whole case now runs in
    // milliseconds rather than the 69 s it took when the early break was removed and nothing replaced it.
    expect(shaped.skipped.at(-1)?.reason).toMatch(/beyond the ingress bounds/);
  }, 60_000);
});

describe('the diagnostic cap must not suppress an ADMISSION', () => {
  it('admits an allowlisted tool hidden behind more decoys than the diagnostic cap', () => {
    // **A capability-denial bug, measured.** The cap on skip ENTRIES also broke the traversal — before the
    // allowlist was consulted — so a hostile server could bury an explicitly allowlisted tool behind 257
    // decoys and it was silently never admitted. `defs` came back EMPTY for a catalogue that contained it.
    // A bound on how much we say must never change what we admit.
    const decoys = Array.from({ length: INGRESS_BOUNDS.toolsPerServer + 1 }, (_, i) =>
      tool(`decoy${i}`, 'ok'),
    );
    const shaped = buildServerToolDefs('s', [...decoys, tool('keep', 'ok')], ['keep']);
    expect(shaped.defs.map((d) => d.id)).toEqual(['mcp_s_keep']);
    // The diagnostic is still bounded — one entry per decoy would be the flood the cap exists to stop.
    expect(shaped.skipped.length).toBeLessThanOrEqual(INGRESS_BOUNDS.toolsPerServer + 1);
    expect(shaped.skipped.at(-1)?.reason).toMatch(/further tool\(s\) refused/);
  });
});

describe('paging stops at the aggregate bound (ADR-0088 §5.2)', () => {
  it('stops asking for pages once the raw discovery budget is spent', async () => {
    // A server whose pages are individually modest but whose TOTAL crosses the budget. The page fetcher
    // counts its own calls, which is the only observation that distinguishes "bounded at admission" from
    // "bounded at the wire" — and the difference is whether the bytes were ever held.
    const perPage = 8;
    const chunk = 'x'.repeat(64 * 1024); // 64 KiB per tool, legal on its own
    let pages = 0;
    const discovered = await collectAllTools(() => {
      pages += 1;
      return Promise.resolve({
        tools: Array.from({ length: perPage }, (_, i) => ({
          name: `p${pages}_${i}`,
          description: chunk,
          inputSchema: schema,
        })),
        nextCursor: String(pages), // an endless catalogue: only the budget can stop this
      });
    });
    // 1 MiB / (8 × 64 KiB) = 2 pages' worth, so it stops at the third at the latest — nowhere near 100.
    expect(pages).toBeLessThanOrEqual(3);
    expect(discovered.length).toBeLessThanOrEqual(perPage * 3);
  });

  it('stops on the TOOL COUNT too, not only on bytes', async () => {
    // The other half of the same aggregate: many tiny tools never cross the byte budget, so a count-blind
    // version would page an endless catalogue forever (up to MAX_TOOL_PAGES).
    let pages = 0;
    const discovered = await collectAllTools(() => {
      pages += 1;
      return Promise.resolve({
        tools: Array.from({ length: 64 }, (_, i) => ({
          name: `t${pages}_${i}`,
          inputSchema: schema,
        })),
        nextCursor: String(pages),
      });
    });
    expect(pages).toBeLessThanOrEqual(5); // 256 / 64 = 4
    expect(discovered.length).toBeGreaterThanOrEqual(INGRESS_BOUNDS.toolsPerServer);
  });

  it('still returns a SHORT catalogue whole — the bound must not truncate a normal server', () => {
    // The false-refusal side: a real server is 5–50 tools with small descriptions, and must page to the end.
    let pages = 0;
    return collectAllTools(() => {
      pages += 1;
      return Promise.resolve({
        tools: Array.from({ length: 10 }, (_, i) => ({
          name: `t${pages}_${i}`,
          inputSchema: schema,
        })),
        ...(pages < 3 ? { nextCursor: String(pages) } : {}),
      });
    }).then((discovered) => {
      expect(pages).toBe(3);
      expect(discovered).toHaveLength(30);
    });
  });
});

describe('DiscoveryBudget', () => {
  it('admits up to the tool count and then refuses, naming the limit', () => {
    const budget = new DiscoveryBudget();
    for (let i = 0; i < INGRESS_BOUNDS.toolsPerServer; i += 1) {
      expect(budget.admit(1)).toBeUndefined();
    }
    expect(budget.admit(1)).toMatch(new RegExp(String(INGRESS_BOUNDS.toolsPerServer)));
    expect(budget.admitted).toBe(INGRESS_BOUNDS.toolsPerServer);
  });

  it('admits EXACTLY at the aggregate byte bound and refuses one past it', () => {
    // The boundary, not near it: "10 under" would pass against a `>=` that rejects the legal maximum.
    const atLimit = new DiscoveryBudget();
    expect(atLimit.admit(INGRESS_BOUNDS.discoveryBytesPerServer)).toBeUndefined();
    expect(atLimit.exhausted).toBe(false);

    const over = new DiscoveryBudget();
    expect(over.admit(INGRESS_BOUNDS.discoveryBytesPerServer + 1)).toMatch(/exceed the maximum/);
    expect(over.exhausted).toBe(true);
  });

  it('stays exhausted — it does NOT admit a smaller tool that happens to fit afterwards', () => {
    // **Order stability is the point.** A budget that resumed admitting would give a different tool set
    // depending on which page arrived first, so the same server could grant two agents different tools.
    const budget = new DiscoveryBudget();
    expect(budget.admit(INGRESS_BOUNDS.discoveryBytesPerServer + 1)).toBeDefined();
    expect(budget.admit(1)).toMatch(/already exhausted/);
    expect(budget.admitted).toBe(0);
  });
});

describe('per-tool bounds', () => {
  it('drops a tool whose description is over the bound, and keeps the rest of the catalogue', () => {
    // One enormous description is a bad TOOL, not a bad server — so the sibling tools still work.
    const shaped = buildServerToolDefs('s', [
      tool('ok', 'fine'),
      tool('huge', 'x'.repeat(INGRESS_BOUNDS.toolDescriptionBytes + 1)),
      tool('also_ok', 'fine'),
    ]);
    expect(shaped.defs.map((d) => d.id)).toEqual(['mcp_s_ok', 'mcp_s_also_ok']);
    expect(shaped.skipped).toHaveLength(1);
    expect(shaped.skipped[0]?.name).toBe('huge');
    expect(shaped.skipped[0]?.reason).toMatch(/above the limit/);
  });

  it('the BUDGET refuses past the tool count, even when every description is tiny', () => {
    // **A mutation found this gap, not a reading.** Deleting the budget charge from `buildServerToolDefs`
    // left every test green: the hostile-catalogue case refuses each tool on its DESCRIPTION before the
    // budget is consulted, and the `DiscoveryBudget` tests drive the class directly. The wiring between them
    // was the untested part — which is the shape this phase keeps finding.
    const many = Array.from({ length: INGRESS_BOUNDS.toolsPerServer + 10 }, (_, i) =>
      tool(`t${i}`, 'ok'),
    );
    const shaped = buildServerToolDefs('s', many);
    expect(shaped.defs).toHaveLength(INGRESS_BOUNDS.toolsPerServer);
    expect(shaped.skipped[0]?.reason).toMatch(
      new RegExp(`more than the maximum of ${INGRESS_BOUNDS.toolsPerServer} tools`),
    );
  });

  it('the BUDGET refuses on aggregate BYTES, before the tool count is reached', () => {
    // The other half: few tools, each individually legal, whose SUM exceeds the server budget. Without the
    // aggregate, 256 tools at 8 KiB each is 2 MiB admitted — twice the bound — before a schema is counted.
    const chunk = 'x'.repeat(INGRESS_BOUNDS.toolDescriptionBytes); // legal per-tool
    const perServer = Math.ceil(
      INGRESS_BOUNDS.discoveryBytesPerServer / INGRESS_BOUNDS.toolDescriptionBytes,
    );
    const heavy = Array.from({ length: perServer + 5 }, (_, i) => tool(`h${i}`, chunk));
    const shaped = buildServerToolDefs('s', heavy);
    expect(shaped.defs.length).toBeLessThan(perServer + 5);
    expect(shaped.defs.length).toBeLessThan(INGRESS_BOUNDS.toolsPerServer); // the BYTES bound bit first
    expect(shaped.skipped[0]?.reason).toMatch(/exceed the maximum of \d+ bytes/);
  });

  it('admits a description EXACTLY at the bound', () => {
    const shaped = buildServerToolDefs('s', [
      tool('edge', 'x'.repeat(INGRESS_BOUNDS.toolDescriptionBytes)),
    ]);
    expect(shaped.defs).toHaveLength(1);
  });

  it('counts UTF-8 BYTES, not UTF-16 units — the multi-byte case a `.length` gets wrong', () => {
    // `'😀'` is 2 UTF-16 units and 4 UTF-8 bytes. A `.length` bound would admit roughly twice the payload,
    // which is why ADR-0088 §5.2 makes the unit normative rather than obvious.
    const emoji = '😀'.repeat(INGRESS_BOUNDS.toolDescriptionBytes / 4);
    expect(emoji.length).toBeLessThan(INGRESS_BOUNDS.toolDescriptionBytes); // a `.length` check would pass
    expect(overSizedDescription(emoji)).toBeUndefined(); // exactly at the byte bound
    expect(overSizedDescription(emoji + '😀')).toMatch(/above the limit/);
  });
});

describe('toolDefinitionBytes', () => {
  it('counts the name, the description AND the serialized schema', () => {
    // The schema is what a provider actually receives, so a catalogue of tiny names with enormous schemas
    // must charge against the same budget.
    const bare = toolDefinitionBytes({ name: 'a', inputSchema: {} });
    const withSchema = toolDefinitionBytes({
      name: 'a',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'string', description: 'y'.repeat(500) } },
      },
    });
    expect(withSchema).toBeGreaterThan(bare + 400);
  });

  it('does not throw on an unserialisable schema — that is the compiler’s refusal, not a size question', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(jsonByteLength(cyclic)).toBe(0);
    expect(() => toolDefinitionBytes({ name: 'a', inputSchema: cyclic })).not.toThrow();
  });
});

describe('tool-result text bound', () => {
  it('refuses a result whose text exceeds the bound ACROSS ALL PARTS', () => {
    // A thousand parts of a kilobyte is the same megabyte as one part of a megabyte; a per-part bound would
    // have missed it entirely.
    const part = { type: 'text', text: 'x'.repeat(64 * 1024) };
    const parts = Array.from({ length: 17 }, () => part); // 17 × 64 KiB > 1 MiB
    expect(() => shapeToolResult({ content: parts })).toThrow(McpError);
  });

  it('admits a result at the bound, and rejects rather than truncating past it', () => {
    const atLimit = {
      content: [{ type: 'text', text: 'x'.repeat(INGRESS_BOUNDS.toolResultTextBytes) }],
    };
    expect(shapeToolResult(atLimit).content).toHaveLength(1);

    const over = {
      content: [{ type: 'text', text: 'x'.repeat(INGRESS_BOUNDS.toolResultTextBytes + 1) }],
    };
    // Rejection, never truncation: half a tool result reads to the model as a complete answer.
    expect(() => shapeToolResult(over)).toThrow(/exceeds the maximum/);
  });

  it('does not count a NON-TEXT part’s bytes — it carries only a kind', () => {
    // The shaping already drops non-text bytes, so charging them would refuse a result that is in fact tiny.
    const result = shapeToolResult({
      content: [{ type: 'image', data: 'A'.repeat(4 * 1024 * 1024) }],
    });
    expect(result.content).toEqual([{ type: 'non_text', kind: 'image' }]);
  });
});
