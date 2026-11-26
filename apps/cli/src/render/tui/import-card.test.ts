/**
 * The import card of the Home's `/import` ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5, increment 6): a path field, then a card that shows what would be written, whose default is No, and whose only Yes is a
 * `Ctrl+Y` the chord guard accepts, once, through the commit. `Esc`, `Ctrl+C`, `Ctrl+N`, a flow cancelled under the card and every key that
 * is not a chord write nothing; a refusal is shown in the same place and writes nothing; the card never overwrites.
 *
 * The prompt channel is the real one (keys go in through `ui.input` and `ui.paste`, as the host's `useInput` delivers them) and so is the
 * port over a temporary project, so "writes nothing" is read from the directory and not from a flag the card keeps. Every project and
 * home is a temporary directory.
 *
 * MVP-11 unit 6 (6.3): the card is a popup now (`framedFlow`, rail `Path · Review · Done`), so the rig plays the flow's first frame as shown
 * before it types (the opening guard drops a key no frame was shown for), a write ends in the persistent Done step (what was imported and the
 * file it went to, project-relative; a refused write says so there), a refusal is a step of the popup with its reason under it, and the flow
 * resolves with a notification only when nothing was written and nothing said so (`IMPORT_NOT_WRITTEN`).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import type { Key } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareImport } from '../../commands/import.js';
import { createImportPort } from '../../home/import-port.js';
import type { GlobalOptions } from '../../process/options.js';
import { settleFrames, waitFor } from './harness-util.js';
import {
  IMPORT_ALLOW_LABEL,
  IMPORT_CANNOT,
  IMPORT_CLOSE_LABEL,
  IMPORT_DENY_LABEL,
  IMPORT_FAILED,
  IMPORT_NOT_WRITTEN,
  IMPORT_PATH_MESSAGE,
  importCardText,
  runImportCard,
  type ImportPort,
  type ImportPrepared,
} from './import-card.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ctrl: Key = { ...none, ctrl: true };
const enter: Key = { ...none, return: true };
const esc: Key = { ...none, escape: true };

const AGENT = `# an external agent (this comment is dropped on import)
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const WORKFLOW = `schema_version: '1.0'
workflow:
  id: reviewer
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;
const LITERAL = 'sk-importedSyntheticCredential123456789';
const SOURCE = 'incoming.agent.yaml';
const DESTINATION = '.relavium/agents/reviewer.agent.yaml';
const REPLACE = 'To replace it, run relavium import --force with the same file.';

let root = '';
let home = '';
let outside = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-card-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-card-home-'));
  outside = mkdtempSync(join(tmpdir(), 'relavium-import-card-out-'));
  mkdirSync(join(root, '.relavium'), { recursive: true });
  writeFileSync(join(root, SOURCE), AGENT);
});
afterEach(() => {
  cleanup();
  for (const dir of [root, home, outside]) rmSync(dir, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd: root,
  configPath: undefined,
  verbosity: 'normal',
});
const target = (): string => join(root, DESTINATION);
/** What a project directory holds, recursively and sorted: the whole of "nothing was written". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

/** The real port over the temporary project, with every prepare and every commit counted. */
function countingPort() {
  const commits = vi.fn();
  const prepares = vi.fn();
  const base = createImportPort({ global: global(), homeDir: home });
  const port: ImportPort = {
    pathIssue: base.pathIssue,
    prepare: (pathText): ImportPrepared => {
      prepares(pathText);
      const prepared = base.prepare(pathText);
      if (!prepared.ok) return prepared;
      return {
        ...prepared,
        commit: () => {
          commits();
          return prepared.commit();
        },
      };
    },
  };
  return { port, commits, prepares };
}

/** Where the rig's clock is when the path field is shown, when the card is shown, and when it is answered (each well past the guards). */
const FIELD_SHOWN_AT = 1;
const FIELD_ANSWERED_AT = 1000;
const CARD_SHOWN_AT = 2000;
const CARD_ANSWERED_AT = 12_000;

/** The real channel with a clock the test moves, and the card asked for. */
function rig(over: { readonly port?: ImportPort } = {}) {
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const counted = countingPort();
  const result = runImportCard({ flow: channel.flow, port: over.port ?? counted.port });
  /** Wait for the path field, and play its frame as shown (the popup's opening guard counts from it) and settled. */
  const fieldUp = async (): Promise<void> => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('text'), {
      timeout: WAIT_MS,
    });
    now = FIELD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = FIELD_ANSWERED_AT;
  };
  /** Type a path into the field, as a paste, and press Enter. */
  const submit = (text: string): void => {
    channel.ui.paste(text);
    channel.ui.input('', enter);
  };
  /** Wait for the card, then let it be painted and read. */
  const cardUp = async (path = SOURCE): Promise<void> => {
    await fieldUp();
    submit(path);
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = CARD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = CARD_ANSWERED_AT;
  };
  /** Wait for the refusal. */
  const refusalUp = async (path: string): Promise<void> => {
    await fieldUp();
    submit(path);
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('select'), {
      timeout: WAIT_MS,
    });
  };
  /**
   * The persistent Done step (ADR-0148 §6): what it said, its tone and the file its one option names; then `Enter` closes it and the flow's
   * result (the notification it asks the Home for: none, the step said it) is read.
   */
  const done = async () => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBeDefined(), {
      timeout: WAIT_MS,
    });
    const step = channel.ui.getSnapshot();
    channel.ui.input('', enter);
    const notification = await result;
    return {
      message: step.message,
      lines: step.details,
      target: step.options[0]?.hint,
      tone: step.final,
      step,
      notification,
    };
  };
  return {
    ...channel,
    ...counted,
    result,
    fieldUp,
    submit,
    cardUp,
    refusalUp,
    done,
    at: (ms: number) => (now = ms),
  };
}

describe('the path field asks for a path, and nothing more', () => {
  it('is one text field with the card’s question, and reads nothing until Enter', async () => {
    const before = tree(root);
    const r = rig();
    await r.fieldUp();
    const field = r.ui.getSnapshot();
    expect(field.kind).toBe('text');
    expect(field.message).toBe(IMPORT_PATH_MESSAGE);
    expect(field.options, 'it is not a listing').toEqual([]);
    r.ui.paste(SOURCE);
    expect(r.prepares, 'typing reads nothing').not.toHaveBeenCalled();
    expect(tree(root)).toEqual(before);
    r.ui.input('', esc);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
  });

  it('Enter on an empty field, and on a path over the bound, stays in the field with the reason and reads nothing', async () => {
    const r = rig();
    await r.fieldUp();
    r.ui.input('', enter);
    expect(r.ui.getSnapshot().kind).toBe('text');
    expect(r.ui.getSnapshot().error).toBe('Type the path of a workflow or agent YAML file.');
    r.ui.paste('a'.repeat(1025));
    r.ui.input('', enter);
    expect(r.ui.getSnapshot().kind).toBe('text');
    expect(r.ui.getSnapshot().error).toBe('The path is longer than 1,024 characters.');
    expect(r.prepares).not.toHaveBeenCalled();
    r.ui.input('', esc);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
    expect(r.prepares).not.toHaveBeenCalled();
  });

  it('a path of exactly 1,024 characters is let through (to be refused as a file that is not there)', async () => {
    const r = rig();
    await r.refusalUp('a'.repeat(1024));
    expect(r.prepares).toHaveBeenCalledTimes(1);
    expect(r.ui.getSnapshot().message).toBe(IMPORT_CANNOT);
    // the file system's own refusal of a name that long, in the command's words (which words is the platform's)
    expect(r.ui.getSnapshot().details[0]).toMatch(/\S/u);
    r.ui.input('', enter);
    expect(await r.result, 'the refusal was read where it was shown').toBeUndefined();
  });

  it('a control character in what is pasted is refused by the field itself, and Enter cannot send it', async () => {
    const r = rig();
    await r.fieldUp();
    r.ui.paste('in\u0001coming.agent.yaml');
    expect(r.ui.getSnapshot().error).toContain('control characters');
    r.ui.input('', enter);
    expect(r.ui.getSnapshot().kind, 'still the field').toBe('text');
    expect(r.prepares).not.toHaveBeenCalled();
    r.ui.input('', esc);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
    expect(r.prepares).not.toHaveBeenCalled();
  });

  it.each([
    ['Esc', (f: ReturnType<typeof rig>) => f.ui.input('', esc)],
    ['Ctrl+C', (f: ReturnType<typeof rig>) => f.ui.input('c', ctrl)],
    ['the flow being cancelled under it', (f: ReturnType<typeof rig>) => f.flow.cancel()],
  ])('%s at the field writes nothing, reads nothing and ends the flow', async (_name, press) => {
    const before = tree(root);
    const r = rig();
    await r.fieldUp();
    r.ui.paste(SOURCE);
    press(r);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
    expect(r.prepares).not.toHaveBeenCalled();
    expect(r.commits).not.toHaveBeenCalled();
    expect(tree(root)).toEqual(before);
    expect(r.ui.getSnapshot().active).toBe(false);
  });
});

describe('the card says what it would write, and where, before it asks', () => {
  it('names the kind, the id, where it comes from and where it goes, the size, and Yes and No in words', async () => {
    const before = tree(root);
    const r = rig();
    await r.cardUp();
    const card = r.ui.getSnapshot();
    expect(card.kind).toBe('chord');
    // the popup's Review step (ADR-0148 §1): `/import`, from the Home, step 2 of 3
    expect(card.popup).toMatchObject({
      title: '/import',
      origin: 'home',
      stepIndex: 1,
      stepCount: 3,
      stepNames: ['Path', 'Review', 'Done'],
    });
    expect(card.message).toBe("Import agent 'reviewer' into this project?");
    expect(card.details[0]).toBe(`from        ${SOURCE}`);
    expect(card.details[1]).toBe(`to          ${DESTINATION}`);
    expect(card.details[2]).toMatch(/^size {8}\d[\d,]* bytes$/u);
    expect(card.details.at(-1)).toBe(
      'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.',
    );
    expect(card.options.map((option) => option.label)).toEqual([
      IMPORT_ALLOW_LABEL,
      IMPORT_DENY_LABEL,
    ]);
    expect(existsSync(target()), 'asking writes nothing').toBe(false);
    expect(tree(root)).toEqual(before);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
  });

  it('shows the byte count the file then has, and writes exactly the prepared content', async () => {
    const plan = prepareImport({ path: SOURCE, force: false }, { global: global(), homeDir: home });
    const r = rig();
    await r.cardUp();
    const shown = /^size\s+([\d,]+) bytes$/u.exec(r.ui.getSnapshot().details[2] ?? '')?.[1];
    expect(Number((shown ?? '').replaceAll(',', ''))).toBe(plan.bytes);
    r.ui.input('y', ctrl);
    const done = await r.done();
    expect(done.message).toBe("Imported agent 'reviewer'");
    expect(done.target).toBe(DESTINATION);
    expect(done.tone).toBe('ok');
    expect(done.step.popup?.stepIndex).toBe(2);
    expect(done.notification).toBeUndefined();
    const written = readFileSync(target());
    expect(written, 'the written bytes are the plan’s content, exactly').toEqual(
      Buffer.from(plan.content, 'utf8'),
    );
    expect(written).toHaveLength(plan.bytes);
    expect(readFileSync(join(root, SOURCE), 'utf8'), 'the file named is not changed').toBe(AGENT);
  });

  it('a workflow file is a workflow on the card, and lands under workflows/', async () => {
    writeFileSync(join(root, 'flow.yaml'), WORKFLOW.replace('id: reviewer', 'id: code-review'));
    const r = rig();
    await r.cardUp('flow.yaml');
    expect(r.ui.getSnapshot().message).toBe("Import workflow 'code-review' into this project?");
    expect(r.ui.getSnapshot().details[1]).toBe(
      'to          .relavium/workflows/code-review.relavium.yaml',
    );
    r.ui.input('y', ctrl);
    const done = await r.done();
    expect(done.message).toBe("Imported workflow 'code-review'");
    expect(done.target).toBe('.relavium/workflows/code-review.relavium.yaml');
    expect(done.lines).toEqual(['Next: /run runs it, and /workflows lists it.']);
    expect(existsSync(join(root, '.relavium', 'workflows', 'code-review.relavium.yaml'))).toBe(
      true,
    );
  });

  it('a leading ~ is the Home’s operator home, and the source is shown as the command shows it', async () => {
    writeFileSync(join(home, 'from-home.agent.yaml'), AGENT);
    const r = rig();
    await r.cardUp('~/from-home.agent.yaml');
    expect(r.ui.getSnapshot().details[0]).toBe(
      `from        ${join('..', home.split(sep).pop() ?? '', 'from-home.agent.yaml')}`,
    );
    r.ui.input('y', ctrl);
    expect((await r.done()).message).toBe("Imported agent 'reviewer'");
    expect(existsSync(target())).toBe(true);
  });

  it('shows the command’s notice about a literal, in its words and without the value, and keeps the literal in the file', async () => {
    writeFileSync(join(root, 'secret.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
    const r = rig();
    await r.cardUp('secret.agent.yaml');
    const card = r.ui.getSnapshot();
    expect(card.details.slice(3, -1)).toEqual([
      'Warning: authored definition has 1 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.',
    ]);
    expect(JSON.stringify(card)).not.toContain(LITERAL);
    r.ui.input('y', ctrl);
    expect(JSON.stringify((await r.done()).step)).not.toContain(LITERAL);
    expect(readFileSync(target(), 'utf8')).toContain(LITERAL);
  });

  it('groups the number and bounds the long parts, so the card keeps its shape', () => {
    const text = importCardText({
      kind: 'agent',
      slug: 'a'.repeat(300),
      source: `${'s/'.repeat(300)}file.yaml`,
      destination: `${'d/'.repeat(300)}file.yaml`,
      target: `${'d/'.repeat(300)}file.yaml`,
      bytes: 1234567,
      warnings: ['w'.repeat(900), 'x', 'a third that is never drawn'],
    });
    expect(text.details[2]).toBe('size        1,234,567 bytes');
    expect(text.message.length).toBeLessThan(120);
    expect(text.details[0]?.length).toBeLessThanOrEqual('from        '.length + 120);
    expect(text.details[1]?.length).toBeLessThanOrEqual('to          '.length + 160);
    expect(text.details).toHaveLength(3 + 2 + 1);
    expect(text.details[3]?.length).toBeLessThanOrEqual(320);
    expect(
      importCardText({
        kind: 'workflow',
        slug: 's',
        source: 'f',
        destination: 'g',
        target: 'g',
        bytes: 1,
        warnings: [],
      }).details[2],
    ).toBe('size        1 byte');
  });
});

describe('what an authored file says is drawn as text and never as a terminal command', () => {
  const ESC_SLUG = 'a\u001b]0;pwned\u0007b\u001b[31mred';
  const BIDI = String.fromCharCode(0x202e);

  /** A port that offers whatever it is handed, so the card’s own floor is what is read. */
  const stubPort = (offer: Extract<ImportPrepared, { ok: true }>['offer']): ImportPort => ({
    pathIssue: () => undefined,
    prepare: () => ({ ok: true, offer, commit: () => ({ ok: true, written: 'x' }) }),
  });

  it('an id that holds an escape sequence reaches the screen without it, in the question and in the rows', async () => {
    const r = rig({
      port: stubPort({
        kind: 'agent',
        slug: ESC_SLUG,
        source: `src${BIDI}/\u001b[2Jfile.yaml`,
        destination: `.relavium/agents/${ESC_SLUG}.agent.yaml`,
        target: `.relavium/agents/${ESC_SLUG}.agent.yaml`,
        bytes: 3,
        warnings: [`Warning: ${ESC_SLUG}\u001b[0m`],
      }),
    });
    await r.cardUp();
    const card = r.ui.getSnapshot();
    const everything = [card.message, ...card.details].join('\n');
    expect(everything).not.toContain('\u001b');
    expect(everything).not.toContain('\u0007');
    expect(everything).not.toContain(BIDI);
    // The sequence is dropped whole, its payload with it; what was around it is shown as text.
    expect(card.message).toBe("Import agent 'abred' into this project?");
    r.ui.input('n', ctrl);
    await r.result;
  });

  it('a refusal that quotes a hostile path is drawn without its escapes too', async () => {
    const r = rig({
      port: {
        pathIssue: () => undefined,
        prepare: () => ({ ok: false, reason: `no file at \u001b[2J${BIDI}evil.yaml\u0007` }),
      },
    });
    await r.refusalUp('x');
    const card = r.ui.getSnapshot();
    const reason = card.details.join('\n');
    expect(reason).toContain('evil.yaml');
    expect(reason).not.toContain('\u001b');
    expect(reason).not.toContain('\u0007');
    expect(reason).not.toContain(BIDI);
    r.ui.input('', enter);
    await r.result;
  });
});

describe('the default is No', () => {
  it('a bare letter, Enter, a paste and an arrow leave the card open and write nothing; only a chord answers', async () => {
    const r = rig();
    await r.cardUp();
    r.ui.input('y', none);
    r.ui.input('Y', { ...none, shift: true });
    r.ui.input('', enter);
    r.ui.input('', { ...none, downArrow: true });
    r.ui.paste('y');
    r.ui.paste('\x19');
    await Promise.resolve();
    expect(r.ui.getSnapshot().kind, 'still the card').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    r.at(60_000);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(r.ui.getSnapshot().active, 'the flow is ended').toBe(false);
  });

  const answers: Array<[string, (f: ReturnType<typeof rig>) => void]> = [
    ['Ctrl+N', (f) => f.ui.input('n', ctrl)],
    ['Esc', (f) => f.ui.input('', esc)],
    ['Ctrl+C', (f) => f.ui.input('c', ctrl)],
    ['the flow being cancelled under the card', (f) => f.flow.cancel()],
  ];
  it.each(answers)('%s writes nothing, calls no commit and ends the flow', async (_name, press) => {
    const before = tree(root);
    const r = rig();
    await r.cardUp();
    press(r);
    expect(await r.result).toBe(IMPORT_NOT_WRITTEN);
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(existsSync(join(root, '.relavium', 'agents')), 'not even its directory').toBe(false);
    expect(tree(root)).toEqual(before);
    expect(r.ui.getSnapshot().active).toBe(false);
  });
});

describe('a card closes with the work it asks about', () => {
  it('a signal that aborts while the card is open closes it as a No and writes nothing', async () => {
    let now = 0;
    const channel = createNativePromptChannel({ now: () => now });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const stop = new AbortController();
    // The Home's own flow hands its abort signal to the card: a Home that is closing aborts it.
    const flow = {
      ...channel.flow,
      begin: () => {
        channel.flow.begin();
        return stop.signal;
      },
    };
    const counted = countingPort();
    const result = runImportCard({ flow, port: counted.port });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('text'), {
      timeout: WAIT_MS,
    });
    now = FIELD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = FIELD_ANSWERED_AT;
    channel.ui.paste(SOURCE);
    channel.ui.input('', enter);
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    stop.abort();
    expect(await result).toBe(IMPORT_NOT_WRITTEN);
    expect(counted.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(channel.ui.getSnapshot().active, 'the flow is ended').toBe(false);
  });

  it('opens no field for a Home that is closing, and prepares nothing', async () => {
    const prepare = vi.fn();
    const channel = createNativePromptChannel();
    await expect(
      runImportCard({
        flow: channel.flow,
        port: { pathIssue: () => undefined, prepare },
        assertAdmitting: () => {
          throw new Error('the Home is closing');
        },
      }),
    ).rejects.toThrow('the Home is closing');
    expect(prepare).not.toHaveBeenCalled();
    expect(channel.ui.getSnapshot().active).toBe(false);
  });
});

describe('Yes writes once, through the commit, and only past the chord guard', () => {
  it('Ctrl+Y after the card has settled writes the file once; a second Ctrl+Y finds no card and writes nothing more', async () => {
    const r = rig();
    await r.cardUp();
    r.ui.input('y', ctrl);
    await vi.waitFor(() => expect(r.ui.getSnapshot().final).toBe('ok'), { timeout: WAIT_MS });
    expect(r.commits).toHaveBeenCalledTimes(1);
    const written = readFileSync(target(), 'utf8');
    expect(written).toBe(
      'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n',
    );
    r.ui.input('y', ctrl); // a held key: the Done step takes no chord, and there is no card to answer
    await Promise.resolve();
    expect(r.ui.getSnapshot().final, 'the Done step stays').toBe('ok');
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect((await r.done()).message).toBe("Imported agent 'reviewer'");
    expect(readFileSync(target(), 'utf8')).toBe(written);
    expect(r.ui.getSnapshot().active).toBe(false);
  });

  it('Ctrl+Y inside the dwell is not a Yes: nothing is written until the card has been on screen long enough', async () => {
    const r = rig();
    await r.fieldUp();
    r.submit(SOURCE);
    await vi.waitFor(() => expect(r.ui.getSnapshot().kind).toBe('chord'), { timeout: WAIT_MS });
    r.at(CARD_SHOWN_AT);
    r.ui.shown(r.ui.getSnapshot());
    r.at(CARD_SHOWN_AT + 5); // the frame has just appeared
    r.ui.input('y', ctrl);
    expect(r.ui.getSnapshot().kind, 'the card stays').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    r.at(60_000);
    r.ui.input('y', ctrl);
    expect((await r.done()).message).toBe("Imported agent 'reviewer'");
    expect(r.commits).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Y on a card that is not on screen is not a Yes', async () => {
    let now = 0;
    const channel = createNativePromptChannel({ now: () => now });
    channel.ui.bindVisibility(() => false); // the exact frame was never measured and flushed
    const counted = countingPort();
    const result = runImportCard({ flow: channel.flow, port: counted.port });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('text'), {
      timeout: WAIT_MS,
    });
    now = FIELD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = FIELD_ANSWERED_AT;
    channel.ui.paste(SOURCE);
    channel.ui.input('', enter);
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = CARD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = 60_000;
    channel.ui.input('y', ctrl);
    expect(channel.ui.getSnapshot().kind).toBe('chord');
    expect(counted.commits).not.toHaveBeenCalled();
    channel.flow.cancel();
    expect(await result).toBe(IMPORT_NOT_WRITTEN);
    expect(existsSync(target())).toBe(false);
  });

  it('a file that appeared between the card and the answer is kept, and the refusal says the card never overwrites', async () => {
    const r = rig();
    await r.cardUp();
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'someone else wrote this\n');
    r.ui.input('y', ctrl);
    const done = await r.done();
    expect(done.tone).toBe('failed');
    expect(done.message).toBe(IMPORT_FAILED);
    expect(done.lines).toEqual([
      `${DESTINATION} already exists, and this card never overwrites. ${REPLACE}`,
    ]);
    expect(done.notification).toBeUndefined();
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(readFileSync(target(), 'utf8')).toBe('someone else wrote this\n');
  });

  it('an id that appeared under another name between the card and the answer is refused, and the card writes nothing', async () => {
    const r = rig();
    await r.cardUp();
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(join(root, '.relavium', 'agents', 'renamed.agent.yaml'), AGENT);
    r.ui.input('y', ctrl);
    expect((await r.done()).lines).toEqual([
      `agent 'reviewer' already exists in this project, and this card never overwrites. ${REPLACE}`,
    ]);
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(existsSync(target())).toBe(false);
    expect(readdirSync(join(root, '.relavium', 'agents'))).toEqual(['renamed.agent.yaml']);
  });

  it('a directory that appeared between the card and the answer is refused, with no --force offered for it', async () => {
    const r = rig();
    await r.cardUp();
    mkdirSync(target(), { recursive: true });
    r.ui.input('y', ctrl);
    const reason = (await r.done()).lines.join('\n');
    expect(reason).toContain('already exists and is not a regular file');
    expect(reason).not.toContain('--force');
    expect(readdirSync(target())).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'a link that appeared between the card and the answer is not written through',
    async () => {
      const r = rig();
      await r.cardUp();
      mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
      const victim = join(outside, 'victim.yaml');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, target());
      r.ui.input('y', ctrl);
      const done = await r.done();
      expect(done.tone).toBe('failed');
      expect(done.message).toBe(IMPORT_FAILED);
      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    },
  );
});

describe('a refusal is shown in the card, and writes nothing', () => {
  it('an id the project already has is refused before the card asks, naming the shell command, and the file is kept', async () => {
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), AGENT);
    const before = tree(root);
    const r = rig();
    await r.refusalUp(SOURCE);
    const card = r.ui.getSnapshot();
    expect(card.message).toBe(IMPORT_CANNOT);
    expect(card.details).toEqual([
      `agent 'reviewer' already exists in this project, and this card never overwrites. ${REPLACE}`,
    ]);
    expect(card.final, 'drawn as what failed').toBe('failed');
    expect(card.popup?.stepIndex, 'on the Review step').toBe(1);
    expect(card.options.map((option) => option.label)).toEqual([IMPORT_CLOSE_LABEL]);
    r.ui.input('', enter);
    expect(await r.result, 'the refusal was read where it was shown').toBeUndefined();
    expect(r.commits, 'there was nothing to commit').not.toHaveBeenCalled();
    expect(readFileSync(target(), 'utf8')).toBe(AGENT);
    expect(tree(root)).toEqual(before);
    expect(r.ui.getSnapshot().active).toBe(false);
  });

  it('a file at the destination that is no valid entry is refused too, by its name', async () => {
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'pre-existing\n');
    const before = tree(root);
    const r = rig();
    await r.refusalUp(SOURCE);
    expect(r.ui.getSnapshot().details).toEqual([
      `${DESTINATION} already exists, and this card never overwrites. ${REPLACE}`,
    ]);
    r.ui.input('', enter);
    expect(await r.result).toBeUndefined();
    expect(r.commits).not.toHaveBeenCalled();
    expect(readFileSync(target(), 'utf8')).toBe('pre-existing\n');
    expect(tree(root)).toEqual(before);
  });

  it('the other kind’s id is refused in the command’s words, with no --force', async () => {
    mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.relavium', 'workflows', 'reviewer.relavium.yaml'), WORKFLOW);
    const before = tree(root);
    const r = rig();
    await r.refusalUp(SOURCE);
    const reason = r.ui.getSnapshot().details.join('\n');
    expect(reason).toContain("'reviewer' already exists as a workflow");
    expect(reason).not.toContain('--force');
    r.ui.input('', enter);
    expect(await r.result).toBeUndefined();
    expect(tree(root)).toEqual(before);
  });

  it('a destination held by a directory is refused, and so is one held by a link', async () => {
    mkdirSync(target(), { recursive: true });
    const before = tree(root);
    const r = rig();
    await r.refusalUp(SOURCE);
    expect(r.ui.getSnapshot().details.join('\n')).toContain(
      'already exists and is not a regular file',
    );
    r.ui.input('', enter);
    expect(await r.result).toBeUndefined();
    expect(tree(root)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'a destination held by a link is refused, and the link’s target is never written',
    async () => {
      mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
      const victim = join(outside, 'victim.yaml');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, target());
      const r = rig();
      await r.refusalUp(SOURCE);
      expect(r.ui.getSnapshot().details.join('\n')).toContain(
        'already exists and is not a regular file',
      );
      r.ui.input('', enter);
      await r.result;
      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
      expect(r.commits).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a file that is not there', 'nope.yaml', 'no file at nope.yaml'],
    ['a directory', '.relavium', '.relavium is not a regular file'],
  ])('%s is refused with the command’s own words', async (_name, path, reason) => {
    const before = tree(root);
    const r = rig();
    await r.refusalUp(path);
    expect(r.ui.getSnapshot().message).toBe(IMPORT_CANNOT);
    expect(r.ui.getSnapshot().details).toEqual([reason]);
    r.ui.input('', enter);
    expect(await r.result).toBeUndefined();
    expect(tree(root)).toEqual(before);
  });

  it('a file that is neither a workflow nor an agent is refused with the parser’s words', async () => {
    writeFileSync(join(root, 'mystery.yaml'), 'foo: bar\n');
    const before = tree(root);
    const r = rig();
    await r.refusalUp('mystery.yaml');
    expect(r.ui.getSnapshot().details[0]).toMatch(/^mystery\.yaml is not a valid workflow \(/u);
    r.ui.input('', enter);
    expect(await r.result).toBeUndefined();
    expect(r.commits).not.toHaveBeenCalled();
    expect(tree(root)).toEqual(before);
  });

  it('Esc closes the refusal too, and leaves nothing more to say', async () => {
    const r = rig();
    await r.refusalUp('nope.yaml');
    r.ui.input('', esc);
    expect(await r.result).toBeUndefined();
    expect(r.ui.getSnapshot().active).toBe(false);
  });

  it('a fault that is not a refusal propagates, with the flow ended', async () => {
    let now = 0;
    const channel = createNativePromptChannel({
      now: () => now,
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const port: ImportPort = {
      pathIssue: () => undefined,
      prepare: () => ({
        ok: true,
        offer: {
          kind: 'agent',
          slug: 's',
          source: 'f.yaml',
          destination: 'g.yaml',
          target: 'g.yaml',
          bytes: 3,
          warnings: [],
        },
        commit: () => {
          throw new Error('disk fault');
        },
      }),
    };
    const result = runImportCard({ flow: channel.flow, port });
    const settled = result.then(
      () => 'resolved',
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('text'), {
      timeout: WAIT_MS,
    });
    now = FIELD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = FIELD_ANSWERED_AT;
    channel.ui.paste('f.yaml');
    channel.ui.input('', enter);
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = CARD_SHOWN_AT;
    channel.ui.shown(channel.ui.getSnapshot());
    now = CARD_ANSWERED_AT;
    channel.ui.input('y', { ...none, ctrl: true });
    const outcome = await settled;
    expect(outcome instanceof Error && outcome.message).toBe('disk fault');
    expect(channel.ui.getSnapshot().active).toBe(false);
  });
});

describe('the card fits 80×24 and can be answered there', () => {
  /** The two notices the command can write, as long as they are. */
  const WARNINGS = [
    'Warning: authored definition has 2 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.',
    'Warning: authored credential scan is incomplete (scan limit or unsupported structure). Review authored content before sharing or running; unexamined content may contain credentials.',
  ];

  it('draws within 23 rows and 80 columns with the longest source, destination and notices, and a Ctrl+Y at that size writes', async () => {
    const channel = createNativePromptChannel({
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    });
    channel.flow.begin();
    const answer = channel.flow.chord({
      ...importCardText({
        kind: 'workflow',
        slug: 'a-workflow-with-a-fairly-long-slug-that-wraps-the-question-line-onto-more-rows',
        source: `${'a-very-long-directory-name/'.repeat(10)}workflow-to-import.yaml`,
        destination: `${'nested-directory/'.repeat(12)}code-review.relavium.yaml`,
        target: `${'nested-directory/'.repeat(12)}code-review.relavium.yaml`,
        bytes: 4096,
        warnings: WARNINGS,
      }),
      escape: 'cancel',
    });
    const h = render(createElement(NativePromptHost, { ui: channel.ui, color: false }));
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    Object.defineProperty(h.stdout, 'columns', { value: 80 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes(IMPORT_ALLOW_LABEL));
    await settleFrames();
    const frame = h.lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(frame).toContain('from');
    expect(frame).toContain('to');
    expect(frame).toContain('4,096 bytes');
    expect(frame).toContain('credential scan is incomplete');
    expect(frame).toContain(IMPORT_DENY_LABEL);
    expect(frame, 'it fits: not the "does not fit" line').not.toContain('does not fit');
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
    h.stdin.write('\x19'); // Ctrl+Y, as a terminal sends it
    expect(await answer).toBe('allow');
    await channel.flow.end();
    channel.ui.dispose();
  });

  it('draws the refusal, with the longest reason, within 23 rows and 80 columns', async () => {
    const channel = createNativePromptChannel();
    channel.flow.begin();
    void channel.flow.select({
      message: `Cannot import: ${'x'.repeat(2000)}`.slice(0, 240),
      options: [{ value: 'close', label: IMPORT_CLOSE_LABEL }],
      escape: 'cancel',
    });
    const h = render(createElement(NativePromptHost, { ui: channel.ui, color: false }));
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    Object.defineProperty(h.stdout, 'columns', { value: 80 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes(IMPORT_CLOSE_LABEL));
    await settleFrames();
    const lines = (h.lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
    channel.flow.cancel();
    await channel.flow.end();
    channel.ui.dispose();
  });
});
