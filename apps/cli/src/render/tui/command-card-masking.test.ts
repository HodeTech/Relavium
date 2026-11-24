/**
 * What the command card hides is what the engine's event preview of the same command hides (ADR-0118 §1). The two scrubbers
 * (`@relavium/llm`'s diagnostic one, which locates the card's masks, and the engine's, which writes the event preview) do not
 * recognize the same shapes: `password=…`, `--api_key=…` and `secret=…` were masked by the event and shown in clear by the card,
 * by the masked copy (`c`) and by `/details`, so the promise that every masked span must be revealed and drawn before an
 * approving answer counts did not hold for them. These tests drive the surface a person uses (the store's card, its full view,
 * its copy key, the call's details) with the previews the engine's registry makes.
 */
import { scrubbedCommandDisplay, type ToolApprovalRequest, type ToolPreview } from '@relavium/core';
import { quoteCommandLine } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  inspectionPending,
  reduceToolReviewKey,
  reviewInspected,
  toolReviewPage,
  type ToolReviewState,
} from './tool-review-model.js';
import {
  createReviewDocument,
  type ReviewDocument,
  type ReviewField,
  type ReviewPage,
} from './tool-review-projection.js';

const SECRET = 'S3cr3tValue9Zq';
const CTRL = { ctrl: true } as const;
const FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};

/** What `run_command`'s own preview produces: the whole quoted line as the target and one bare value per argument. */
const commandPreview = (argv: readonly string[]): ToolPreview => ({
  kind: 'operation',
  target: quoteCommandLine(argv),
  fields: argv.map((value) => ({ name: '', value })),
});

/** A field's text with every masked span cut out: what a person who has not revealed anything can read of it. */
function readable(field: ReviewField): string {
  let out = '',
    cursor = 0;
  for (const mask of field.masks) {
    out += field.text.slice(cursor, mask.start) + '\u0000';
    cursor = mask.end;
  }
  return out + field.text.slice(cursor);
}
const readableDocument = (document: ReviewDocument): string =>
  document.fields.map(readable).join('\n');

/** The cases of the finding: the shapes the engine masks and the card did not, a header both mask, and an embedded quote. */
const CASES: readonly (readonly [string, readonly string[], string])[] = [
  ['password=<value>', ['tool', `password=${SECRET}`], SECRET],
  ['--api_key=<value>', ['tool', '--api_key=abcd1234efgh5678ijkl'], 'abcd1234efgh5678ijkl'],
  ['secret=<value>', ['tool', 'secret=hunter2'], 'hunter2'],
  [
    'an Authorization header',
    ['curl', '-H', 'Authorization: Bearer sk-abcdefghijklmnop1234567890'],
    'sk-abcdefghijklmnop1234567890',
  ],
  ["a password='<value>' element with an embedded quote", ['psql', `password='${SECRET}'`], SECRET],
  ['a quote elsewhere in the element', ['tool', `it's password='${SECRET}' ok`, 'second'], SECRET],
  ['a secret split from its key across two arguments', ['tool', 'password=', SECRET], SECRET],
];

/** A store whose review frames are drawn by `frame` (an answer or a copy needs a frame the host has shown) and whose clipboard records. */
function openStore() {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const copied: string[] = [];
  store.bindReviewClipboard((text) => {
    copied.push(text);
    return Promise.resolve(true);
  });
  let shown: ToolReviewState | undefined;
  store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
  /** The review as the host draws it: its page is acknowledged, which is what records what the person has been shown. */
  const frame = (): { review: ToolReviewState; page: ReviewPage } => {
    let review = store.getSnapshot().review;
    if (review === undefined) throw new Error('no review is open');
    let page = toolReviewPage(review, 120, 40);
    if (page === undefined) throw new Error('the review has no page');
    store.acknowledgeReviewFrame(review, page);
    // Acknowledging records what was drawn on the review, which is then a new object the host draws again.
    const latest = store.getSnapshot().review;
    if (latest !== undefined && latest !== review) {
      review = latest;
      page = toolReviewPage(review, 120, 40) ?? page;
      store.acknowledgeReviewFrame(review, page);
    }
    review = store.getSnapshot().review ?? review;
    shown = review;
    return { review, page };
  };
  /** A list has no page to acknowledge: it is shown as it is. */
  const showList = (): void => {
    shown = store.getSnapshot().review;
  };
  return { store, copied, frame, showList };
}

function openCard(argv: readonly string[]) {
  const opened = openStore();
  const request: ToolApprovalRequest = {
    toolId: 'run_command',
    action: 'process',
    preview: { command: scrubbedCommandDisplay(argv) },
    unredactedPreview: { command: quoteCommandLine(argv) },
    argv,
    commandAdmitted: false,
  };
  void opened.store.requestApproval(
    request,
    true,
    undefined,
    { callId: 'call', preview: commandPreview(argv) },
    FACTS,
  );
  return opened;
}

describe('a command card hides what the event preview of the command hides', () => {
  it.each(CASES)(
    '%s: the card, its full view and its masked copy never show the secret, and Allow stays locked until it is revealed',
    async (_name, argv, secret) => {
      // The premise: the engine's event preview masks this secret.
      expect(scrubbedCommandDisplay(argv)).not.toContain(secret);

      const { store, copied, frame } = openCard(argv);
      let { review, page } = frame();
      const document = review.document;
      if (document?.valid !== true) throw new Error('the card has no document');

      // The document: every field is read without the secret, and every mask is a requirement.
      expect(document.masks.length).toBeGreaterThan(0);
      expect(readableDocument(document)).not.toContain(secret);
      expect(document.required).toHaveLength(document.masks.length);

      // The card: what it draws, and the copy of it, are free of the secret; Allow is locked on the masks.
      expect(page.rows.join('\n')).not.toContain(secret);
      expect(page.maskedRows.join('\n')).not.toContain(secret);
      expect(inspectionPending(review, page.requiredTarget).masks).toBe(document.masks.length);
      expect(reduceToolReviewKey(review, 'y', CTRL, true, page, true, 0).kind).toBe('none');

      // The full view, masked: the same, and the masked copy `c` writes.
      store.handleReviewInput('v', {});
      ({ review, page } = frame());
      expect(review.screen).toBe('full');
      expect(page.rows.join('\n')).not.toContain(secret);
      expect(page.maskedRows.join('\n')).not.toContain(secret);
      store.handleReviewInput('c', {});
      await Promise.resolve();
      expect(copied).toHaveLength(1);
      expect(copied[0]).not.toContain(secret);
      expect(copied[0]).toContain('<MASK:');
      // A page drawn without the reveal inspects nothing: Allow is still locked.
      expect(reduceToolReviewKey(review, 'y', CTRL, true, page, true, 0).kind).toBe('none');

      // Revealed and drawn, the secret is shown (the reveal is real), the copy still is not, and the lock opens.
      frame(); // the copy's note replaced the review: the host draws the new one before the next key
      store.handleReviewInput('r', {});
      ({ review, page } = frame());
      expect(review.reveal).toBe(true);
      expect(page.rows.join('\n')).toContain(secret);
      expect(page.maskedRows.join('\n')).not.toContain(secret);
      expect(inspectionPending(review, page.requiredTarget).masks).toBe(0);
      expect(reviewInspected(review, page.requiredTarget)).toBe(true);
      expect(reduceToolReviewKey(review, 'y', CTRL, true, page, true, 0).kind).toBe('approve');
    },
  );

  // The details of a call are its retained document, or one rebuilt with the result summary once the call has completed with one.
  const DETAILS = [
    ['as retained from the preview', undefined],
    ['rebuilt with the result summary', 'exited with code 0'],
  ] as const;
  it.each(CASES.flatMap((one) => DETAILS.map((details) => [...one, ...details] as const)))(
    '%s: the call details, opened later, hide it as well (%#)',
    (_name, argv, secret, _how, summary) => {
      const { store, frame, showList } = openStore();
      const preview = commandPreview(argv);
      store.applyToolLiveEvent({ phase: 'preview', callId: 'c1', toolId: 'run_command', preview });
      const document = store.getSnapshot().toolDisplays.get('c1')?.document;
      expect(document?.valid).toBe(true);
      expect(readableDocument(document as ReviewDocument)).not.toContain(secret);
      if (summary !== undefined)
        store.applyToolLiveEvent({
          phase: 'completed',
          callId: 'c1',
          toolId: 'run_command',
          outcome: 'success',
          summary,
        });

      store.openDetails();
      showList();
      store.handleReviewInput('', { return: true });
      const { review, page } = frame();
      expect(review.kind).toBe('details');
      expect(review.document?.fields.map((field) => field.text).join('\n')).toContain(
        summary ?? '',
      );
      expect(page.rows.join('\n')).not.toContain(secret);
      expect(page.maskedRows.join('\n')).not.toContain(secret);
    },
  );

  it('does not mask an ordinary command, and a file edit keeps its own masks', () => {
    const argv = ['git', 'log', '--oneline', '-n', '5', 'a b'];
    const document = createReviewDocument(commandPreview(argv), { requireAllMasks: true });
    expect(document.masks).toEqual([]);
    expect(document.required).toEqual([]);
    expect(readableDocument(document)).toContain("git log --oneline -n 5 'a b'");
    // A document that is not a command's is built exactly as before: the engine's spans are added to a command only.
    const plain = createReviewDocument(commandPreview(['tool', `password=${SECRET}`]));
    expect(plain.masks).toEqual([]);
  });

  it('masks the whole title when the quoting hides a secret from a scan of the title alone', () => {
    const argv = ['psql', `password='${SECRET}'`];
    const document = createReviewDocument(commandPreview(argv), { requireAllMasks: true });
    const title = document.fields[0];
    if (title === undefined) throw new Error('no title');
    expect(title.text).toBe(quoteCommandLine(argv));
    expect(title.masks).toEqual([
      expect.objectContaining({ start: 0, end: title.text.length, field: 0 }),
    ]);
    // While a secret the title does show to its scan is masked where it is, and the rest of the line stays readable.
    const located = createReviewDocument(
      commandPreview(['tool', '-n', '5', `password=${SECRET}`]),
      {
        requireAllMasks: true,
      },
    );
    expect(readable(located.fields[0] as ReviewField)).toBe('tool -n 5 \u0000');
  });
});

describe('everything the event preview masks of a command is masked in the card document', () => {
  const KEYS = ['token', 'password', 'api_key', 'PGPASSWORD', 'client_secret', 'secret'];
  const forms = (key: string): readonly string[] => [
    `${key}='${SECRET}'`,
    `${key}="${SECRET}"`,
    `${key}=${SECRET}`,
    `--${key}='${SECRET}'`,
    `--${key}=${SECRET}`,
    `{'${key}': '${SECRET}'}`,
    `{"${key}": "${SECRET}"}`,
    `${key}: '${SECRET}'`,
    `go ${key}=${SECRET} and then ${key}: ${SECRET}x tail`,
  ];
  const argvs: (readonly string[])[] = [
    ...KEYS.flatMap((key) =>
      forms(key).flatMap((form) => [
        ['psql', form],
        ['tool', '--flag', form, '-n', '5'],
        ['sh', '-c', `echo it's; ${form}`],
      ]),
    ),
    ...KEYS.flatMap((key) => [
      ['tool', `${key}=`, SECRET],
      ['tool', `${key}:`, SECRET],
      ['tool', `--${key}=`, SECRET, 'tail'],
    ]),
    ['curl', '-H', `Authorization: Bearer ${SECRET}${SECRET}`],
    ['curl', '--header', `Authorization: Bearer ${SECRET}${SECRET}`, 'https://example.org'],
    ['psql', `postgres://user:${SECRET}@db.example/app`],
    [`./sk-ant-api03-${SECRET}${SECRET}${SECRET}`, '--version'],
  ];

  it('for every argv whose secret the engine hides, no field of the card shows it', () => {
    let compared = 0;
    for (const argv of argvs) {
      if (scrubbedCommandDisplay(argv).includes(SECRET)) continue; // the engine masks nothing here: nothing to match
      compared += 1;
      const document = createReviewDocument(commandPreview(argv), { requireAllMasks: true });
      expect(document.valid, JSON.stringify(argv)).toBe(true);
      expect(readableDocument(document), JSON.stringify(argv)).not.toContain(SECRET);
      expect(document.required, JSON.stringify(argv)).toHaveLength(document.masks.length);
    }
    expect(compared, 'the corpus exercised the property').toBeGreaterThan(150);
  });

  it('for every argument the engine masks on its own, that argument carries a mask', () => {
    let compared = 0;
    for (const argv of argvs) {
      const document = createReviewDocument(commandPreview(argv), { requireAllMasks: true });
      argv.forEach((value, index) => {
        if (scrubbedCommandDisplay([value]) === quoteCommandLine([value])) return;
        compared += 1;
        const field = document.fields[index + 1];
        expect(field?.text, JSON.stringify(argv)).toBe(value);
        expect(field?.masks.length, JSON.stringify([argv, index])).toBeGreaterThan(0);
      });
    }
    expect(compared, 'the corpus exercised the property').toBeGreaterThan(150);
  });
});

describe('a frozen command preview is built once per kind of document, and no kind answers for another', () => {
  /** What the engine's registry delivers: the preview and every field frozen, which is what lets a document be kept for it. */
  const frozen = (argv: readonly string[]): ToolPreview => {
    const preview = commandPreview(argv);
    for (const field of preview.fields) Object.freeze(field);
    Object.freeze(preview.fields);
    return Object.freeze(preview);
  };

  it('keeps the strict, the command and the ordinary document apart, each built once', () => {
    const preview = frozen(['tool', 'sk-abcdefghijklmnop1234567890', `password=${SECRET}`]);
    const strict = createReviewDocument(preview, { requireAllMasks: true });
    const command = createReviewDocument(preview, { command: true });
    const plain = createReviewDocument(preview);
    // Three kinds, three documents: the card asks for the strict one of the preview the store built the command one of.
    expect(new Set([strict, command, plain]).size).toBe(3);
    // Each is built once for the frozen preview, whatever the order it is asked in.
    expect(createReviewDocument(preview, { requireAllMasks: true })).toBe(strict);
    expect(createReviewDocument(preview, { command: true })).toBe(command);
    expect(createReviewDocument(preview)).toBe(plain);
    // The card's document is the one that makes every mask a requirement: were it the command's, Allow would count unseen.
    expect(strict.required).toHaveLength(strict.masks.length);
    expect(strict.required.length).toBeGreaterThan(0);
    expect(command.required).toHaveLength(0);
    expect(plain.required).toHaveLength(0);
  });

  it('builds a preview that can still change again each time', () => {
    const preview = commandPreview(['tool', `password=${SECRET}`]);
    expect(createReviewDocument(preview, { requireAllMasks: true })).not.toBe(
      createReviewDocument(preview, { requireAllMasks: true }),
    );
  });
});
