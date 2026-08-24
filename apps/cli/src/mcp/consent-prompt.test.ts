/**
 * The consent prompt's COMPOSITION
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7, §10.16, §10.17).
 *
 * The gate's tests assert on the `ConsentSubject` — the data. §10.16 requires the hostile-declaration
 * assertions be made "on the prompt composition", and a review measured five mutations surviving the whole
 * suite because nothing rendered it: the default flipped to Yes, a cancel became an approval, the arguments
 * collapsed into one shell string, the environment vanished, and the executable line could be replaced with
 * `<hidden>`. Each of those is a decision a user would have made on a lie.
 */

import { describe, expect, it } from 'vitest';

import type { ConsentSubject } from '../engine/mcp-consent-gate.js';
import { createConsentPrompter, type ClackConsentDeps } from './consent-prompt.js';

const CANCEL = Symbol('cancel');

/** Records what was rendered and answers with a scripted verdict — no TTY, no clack. */
interface FakeClack extends ClackConsentDeps {
  /** Everything the prompt put on screen, including the confirm line — what §10.16 asserts against. */
  readonly rendered: () => string;
}

function fakeClack(answer: boolean | symbol): FakeClack {
  const lines: string[] = [];
  let confirmed = '';
  return {
    log: {
      message: (text: string): void => {
        lines.push(text);
      },
    },
    confirm: (opts: { message: string; initialValue?: boolean }): Promise<boolean | symbol> => {
      confirmed = opts.message;
      return Promise.resolve(answer);
    },
    isCancel: (value: unknown): value is symbol => value === CANCEL,
    rendered: (): string => `${lines.join('\n')}\n${confirmed}`,
  };
}

const subject = (over: Partial<ConsentSubject> = {}): ConsentSubject => ({
  serverId: 'fs',
  provenance: 'inline',
  artifact: '/w/agent.yaml',
  resolvedCommand: '/usr/local/bin/npx',
  authoredCommand: 'npx',
  args: ['-y', '@acme/fs-server'],
  env: [['ACME_TOKEN', '<secret:acme>']],
  cwd: '/w',
  digest: `v1:${'a'.repeat(64)}`,
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
  ...over,
});

describe('createConsentPrompter', () => {
  it('defaults to NO — a bare Enter must not approve a local program', async () => {
    // Clack's `confirm` defaults to Yes. On a prompt nobody read, that turns the safe key into the
    // dangerous one, which is the opposite of what a consent gate is for.
    let initial: boolean | undefined;
    const deps: ClackConsentDeps = {
      log: { message: (): void => undefined },
      confirm: (opts): Promise<boolean> => {
        initial = opts.initialValue;
        return Promise.resolve(false);
      },
      isCancel: (value): value is symbol => value === CANCEL,
    };
    await createConsentPrompter(deps)(subject());
    expect(initial).toBe(false);
  });

  it('treats a CANCEL and any non-`true` answer as a refusal', async () => {
    // Ctrl-C is an absence of consent, not a deferral — and the gate only ever proceeds on `true`.
    for (const answer of [CANCEL, false, undefined, 'yes']) {
      const deps = fakeClack(answer as boolean | symbol);
      await expect(createConsentPrompter(deps)(subject()), String(answer)).resolves.toBe(false);
    }
  });

  it('approves only on a literal `true`', async () => {
    await expect(createConsentPrompter(fakeClack(true))(subject())).resolves.toBe(true);
  });

  it('renders ONE LINE PER ARGUMENT, never a joined shell string', async () => {
    // Argument boundaries are precisely what an escape sequence or a bidi override would blur, so §7
    // forbids the joined form. `'a b'` is the case that proves the difference.
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(subject({ args: ['--flag', 'a b', '--other'] }));
    const text = deps.rendered();
    expect(text).toContain('argument   --flag');
    expect(text).toContain('argument   a b');
    expect(text).not.toContain('--flag a b --other');
  });

  it('renders the ENVIRONMENT, with a secret reference as a marker', async () => {
    // The environment is the half of a declaration that changes what an executable does; a decision made
    // without it is a decision about a different program.
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(
      subject({
        env: [
          ['ACME_TOKEN', '<secret:acme>'],
          ['ACME_HOME', '/opt/acme'],
        ],
      }),
    );
    const text = deps.rendered();
    expect(text).toContain('ACME_TOKEN=<secret:acme>');
    expect(text).toContain('ACME_HOME=/opt/acme');
  });

  it('names the EXECUTABLE, the artifact, the directory and the digest', async () => {
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(subject());
    const text = deps.rendered();
    expect(text).toContain('/usr/local/bin/npx'); // what will actually run
    expect(text).toContain('as written npx'); // …and what the author wrote, because they differ
    expect(text).toContain('/w/agent.yaml'); // the file that asked
    expect(text).toContain('directory  /w');
    expect(text).toContain(`v1:${'a'.repeat(64)}`);
    expect(text).toContain("Allow MCP server 'fs' to run this program?");
  });

  it('omits the authored spelling when it matches the resolved path', async () => {
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(
      subject({ authoredCommand: undefined, resolvedCommand: '/usr/local/bin/npx' }),
    );
    expect(deps.rendered()).not.toContain('as written');
  });

  it('says WHERE the same program was approved before, when it was', async () => {
    // Consent is project-scoped, so the same program in a second checkout is asked about again. Naming the
    // earlier approval makes that a recognition rather than a fresh decision.
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(subject({ previouslyApprovedIn: '/other/project' }));
    expect(deps.rendered()).toContain('you approved this same program in /other/project');
  });

  it('numbers the decision when an artifact declares more than one', async () => {
    const deps = fakeClack(true);
    await createConsentPrompter(deps)(subject({ total: 3, index: 2 }));
    expect(deps.rendered()).toContain('Program 2 of 3');
  });
});
