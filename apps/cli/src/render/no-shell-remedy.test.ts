import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  REPL_COMMANDS,
  type PaletteSurface,
} from '../commands/repl-commands.js';

/**
 * **No remedy inside the TUI names a shell command, or a command that does not exist**
 * ([ADR-0122](../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §6,
 * [ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §6,
 * [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7.4, MVP-11 OD-20).
 *
 * The Home and the chat speak in actions they have (`/providers`, `/models`, `/pricing`, `/resume`, `/doctor`, `/export`, `/import`,
 * `/init`, `/workflows`, `/agents`, `/run`, `/permissions`). A string that reaches them must not tell a person to type `relavium models
 * refresh`, `relavium provider add`, the deprecated `chat-export`, the pricing flags `--input`/`--output`, or a `/command` the surface
 * does not offer. The plain, `--json`, one-shot and shell outputs keep naming subcommands (ADR-0122 §6), so they are listed here as
 * what they are.
 *
 * **How it works.** Every string in every non-test source file is read from the syntax tree (so a comment never counts), and
 * the patterns below are looked for in it. Three explicit, reasoned lists say what is allowed, and a test fails for each entry
 * that no longer matches anything, so the lists cannot go stale:
 *
 * - {@link SHELL_ONLY_FILES}: whole files whose strings are the shell's own output (a command's stdout/stderr, the help text, the
 *   argv grammar), never drawn inside the TUI.
 * - {@link ALLOWANCES}: single strings in a TUI-reachable file that name a shell command on purpose, each with its reason: the
 *   command is script-only BY DESIGN (no action of the TUI does it), or the string is the shell wording of a sentence whose TUI
 *   wording is chosen by the caller, or the line is printed to the shell after the TUI has closed.
 * - {@link PENDING_ELSEWHERE}: strings in files this sweep did not own. They are the to-do list of whoever owns them; delete an
 *   entry when its string is fixed (this test fails on an entry that matches nothing).
 *
 * A shell command can also be built by a helper (`relaviumRunCommand`, `resumeHint`, …) instead of written out; {@link BUILDER_CALLS}
 * lists the files allowed to call each.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

// ── What a shell remedy looks like ─────────────────────────────────────────────────────────────────────────────────────────

/** `relavium <subcommand>`, the deprecated `chat-export`/`chat-resume`, `provider add`, `models pricing` and the old pricing flags. */
const SHELL_REMEDY = new RegExp(
  [
    String.raw`(?<![\w@./~-])relavium\s+(?:provider|models?|chat|run|gate|status|logs|import|export|create|init|permissions|doctor|agent|workflow|pricing|mcp|budget|list|resume|replay|cost|config|help)\b`,
    String.raw`\bchat-export\b`,
    String.raw`\bchat-resume\b`,
    // The subcommand phrases, with or without `relavium` in front of them: a remedy that says `provider set-key anthropic` is a shell command
    // however it is introduced (it passed unflagged while only the prefixed form was looked for).
    String.raw`\b(?:provider (?:set-key|add)|chat (?:resume|export)|models (?:refresh|pricing)|gate list|permissions revoke)\b`,
    String.raw`(?<![\w-])--(?:input|output)(?![-\w])`,
  ].join('|'),
  'gu',
);

/** A template fragment that ends in the command name and goes on with an interpolation: `` `relavium ${command} … `` */
const DYNAMIC_COMMAND = /(?<![\w@./~-])relavium\s+$/u;

/** `/word`, a slash command named in a sentence (not a path, a fraction or a unit). */
const SLASH_COMMAND = /(?<![\w/.~:'"$`*<-])\/([a-z][a-z-]*)(?![\w/.-])/gu;

/** The helpers that build a shell command line, so that a command is caught whether it is written out or built. */
const COMMAND_BUILDERS = [
  'relaviumRunCommand',
  'resumeHint',
  'humanGateResumeHints',
  'budgetResumeHints',
  'resumeCommandBase',
] as const;
type CommandBuilder = (typeof COMMAND_BUILDERS)[number];

// ── The lists ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Reasoned {
  /** A path under `apps/cli/src`, with `/` separators. */
  readonly file: string;
  readonly reason: string;
}

/** Whole files that are the shell's own output. A directory entry ends in `/` and covers what is under it but the `except` files. */
interface ShellOnly extends Reasoned {
  readonly except?: readonly string[];
}

const SHELL_ONLY_FILES: readonly ShellOnly[] = [
  {
    file: 'commands/',
    reason:
      "each command's own stdout/stderr, its argv grammar and its descriptors: the shell, where a subcommand is the remedy (ADR-0122 §6)",
    // The command files the Home and the chat import and draw from, so their strings are scanned.
    except: [
      'commands/chat.ts',
      'commands/models-pricing.ts',
      'commands/pricing-fields.ts',
      'commands/export.ts',
      'commands/import.ts',
      'commands/inputs.ts',
      'commands/repl-commands.ts',
      'commands/drive.ts',
      'commands/workflow-terminal.ts',
    ],
  },
  { file: 'program.ts', reason: 'the shell `--help` text' },
  {
    file: 'process/errors.ts',
    reason:
      "the shell's stderr mapping; its one `relavium logs` sentence answers an unreadable run event log, which only the shell's history readers raise",
  },
  { file: 'secrets/read-secret.ts', reason: 'the shell prompt for a key piped on stdin' },
  { file: 'gate/decision.ts', reason: "the flag grammar of the shell's `relavium gate`" },
  {
    file: 'gate/budget.ts',
    reason:
      "the builder of the shell's copyable resume command lines (`status`, `logs`, the plain renderer); the only TUI reader is the input-gate card, which says 'In a shell:'",
  },
  { file: 'gate/pending.ts', reason: 'the same builder for a human gate (see gate/budget.ts)' },
  {
    file: 'engine/tool-host/os.ts',
    reason: 'a description of the `--output` flag of a host tool, not a remedy',
  },
  {
    file: 'render/run-command-text.ts',
    reason:
      'the one helper that names a run in a shell command line (see BUILDER_CALLS for who may call it)',
  },
  {
    file: 'render/run-outputs.ts',
    reason: "the outputs block of the shell's renderer, `logs` and the final summary",
  },
  { file: 'render/renderer.ts', reason: "the shell's plain/NDJSON run renderer" },
  {
    file: 'render/tui/final-summary.ts',
    reason:
      'the summary the shell prints once a `relavium run` view has closed (`summaryText`), after the TUI, never a card inside it',
  },
  {
    file: 'chat/resume-hint.ts',
    reason:
      "the line printed to the shell AFTER the chat or the Home has closed (OD-20: the exit line may keep its command); the transcript's own notice is `clearedNotice`",
  },
];

interface Allowance extends Reasoned {
  /** The exact text that is allowed in `file`: it is cut out of the string before the patterns look at what is left. */
  readonly includes: string;
  /** The allowance covers only a string that IS `includes`, not one that merely contains it (a table cell, a bare flag). */
  readonly whole?: true;
}

/** Whether `allowance` covers (part of) `literal`. */
function covers(allowance: Allowance, literal: Literal): boolean {
  if (allowance.file !== literal.file) return false;
  return allowance.whole === true
    ? literal.text === allowance.includes
    : literal.text.includes(allowance.includes);
}

const ALLOWANCES: readonly Allowance[] = [
  // ── The shell wording of a sentence whose wording the caller chooses (the default is `shell`; the interactive chat passes `tui`) ──
  {
    file: 'chat/effort-notice.ts',
    includes: '`relavium models refresh`',
    reason:
      "the `shell` wording of `effortUnavailableNote`; the chat passes 'tui' (tested in effort-notice.test.ts)",
  },
  {
    file: 'chat/effort-notice.ts',
    includes: '`relavium models pricing ',
    reason:
      "the `shell` wording of `unpricedModelNote`, which a caller chooses: the shell's `run`/`gate` and a plain chat pass 'shell', the Home, its hosted legs and the interactive chat pass 'tui' and name /pricing",
  },
  {
    file: 'commands/models-pricing.ts',
    includes: '`relavium models refresh`',
    reason: "the `shell` wording of `pricingSetSentence`; the Home's card passes 'tui'",
  },
  {
    file: 'commands/models-pricing.ts',
    includes: '`relavium models pricing ',
    reason: "the shell's own divergence note after a price is set",
  },
  {
    file: 'commands/models-pricing.ts',
    includes: '`relavium provider add ',
    reason:
      "the shell core's refusal of an unregistered provider; the Home's form lists only registered providers, so the form cannot reach it",
  },
  {
    file: 'commands/models-pricing.ts',
    includes: '`relavium provider set-key ',
    reason: 'the same refusal (see above)',
  },
  {
    file: 'commands/pricing-fields.ts',
    includes: '--input',
    whole: true,
    reason:
      "the shell's own sentences name the flag as the table spells it, byte for byte (models-pricing-characterization.test.ts); the Home's form says the field's label, and a remedy says `canonicalFlag`",
  },
  {
    file: 'commands/pricing-fields.ts',
    includes: '--output',
    whole: true,
    reason: 'the same table row, for the output price',
  },
  {
    file: 'authoring/global-artifacts.ts',
    includes: '`relavium import <path>`',
    reason:
      "the `shell` wording of the global-artifacts notice (`relavium list`); `/doctor` passes 'tui' and names /import",
  },
  {
    file: 'engine/providers.ts',
    includes: '`relavium provider set-key ',
    reason:
      'the `shell` surface of the surface-aware key remedy; the Home and the stand-alone chat take their own branches',
  },
  // ── Script-only by design: no action of the TUI does it ──
  {
    file: 'engine/providers.ts',
    includes: '`relavium provider add ',
    reason:
      "a stored custom base URL that the SSRF gate refused can only be changed by `provider add --base-url`; no TUI form edits an endpoint (the refusal is a chat turn's error)",
  },
  {
    file: 'permissions/chat-permissions.ts',
    includes: 'relavium permissions revoke --all',
    reason:
      'the /permissions sheet withdraws one remembered command at a time (`d`) and cannot act on a file it cannot read or write; only `revoke --all` removes the file and its key',
  },
  {
    file: 'permissions/command-grants.ts',
    includes: '`relavium permissions revoke --all`',
    reason: 'the same file-level removal, in the store notices the sheet and the shell both show',
  },
  {
    file: 'render/tui/run-card-model.ts',
    includes: 'relavium gate list',
    reason:
      'a gate message the card cut has no in-TUI view in full; `gate list` prints it whole (the card says so where it cuts)',
  },
  {
    file: 'render/tui/pricing-card.ts',
    includes: 'Use relavium models pricing.',
    reason:
      'an id the CARD cannot show faithfully (too long, unsafe) can still be priced by the shell core, whose only rule is `modelIdFault`; the padded and invisible ids, which the shell refuses too, name no command',
  },
  {
    file: 'home/consent-card.ts',
    includes: 'Approve it with relavium run.',
    reason:
      "a program path the card cannot show safely cannot be approved in the card; the shell's own prompt shows it",
  },
  {
    file: 'home/defined-port.ts',
    includes: 'Use relavium export ',
    reason:
      "the Home's export card never overwrites (ADR-0140 §9); `--force` exists only in the shell",
  },
  {
    file: 'home/import-port.ts',
    includes: 'run relavium import --force',
    reason:
      "the Home's import card never overwrites (ADR-0140 §9); `--force` exists only in the shell",
  },
  {
    file: 'commands/export.ts',
    includes: 'relavium export <id> --out <path>',
    reason:
      "the Windows device-name refusal of the shared export core; the Home's card has no destination field, so naming the file is a shell option",
  },
  {
    file: 'home/run-host.ts',
    includes: 'read `relavium status`',
    reason:
      'the shell line printed after the Home has closed for a leg it had to abandon (`exitFacts`, ADR-0139 §6)',
  },
  {
    file: 'home/run-host.ts',
    includes: 'Answer it from the shell; `relavium status` shows how.',
    reason:
      'a run recorded with no project root belongs to no directory a Home can be opened in: answering it is a shell action, so the refusal names the shell',
  },
  {
    file: 'render/tui/tab-host-active.ts',
    includes: 'relavium status shows what it waits for.',
    reason:
      'a run whose gate state the Home could not read: the shell reads the same record on its own',
  },
  {
    file: 'render/tui/tab-host-active.ts',
    includes: 'relavium status shows what to do.',
    reason:
      'a run whose end is held in the outbox: only `relavium status` reports it (the History tab says the same)',
  },
  {
    file: 'render/tui/tab-host-history.ts',
    includes: 'relavium logs shows what is wrong with it.',
    reason: 'an event log the Home could not read: the shell reports what is wrong with it',
  },
  {
    file: 'render/tui/tab-host-history.ts',
    includes: 'relavium status shows what to do.',
    reason: 'a run whose end is held in the outbox (see tab-host-active.ts)',
  },
  {
    file: 'render/tui/tab-host-history.ts',
    includes: 'relavium logs shows the rest.',
    reason: 'a log the Home read only in part: the shell reads it whole',
  },
  {
    file: 'render/tui/tab-host-node.ts',
    includes: 'relavium logs <run> --json',
    reason:
      'an output the node view shortened has no in-TUI full view; the `--json` record holds it whole',
  },
  {
    file: 'commands/inputs.ts',
    includes: '--input',
    reason:
      "the shell's argv refusals (`--input k=v`); the Home's launch form fills declared fields only, so its validation (`fieldIssue`) cannot reach them",
  },
  // ── The plain driver and the shell commands of the chat module ──
  {
    file: 'commands/chat.ts',
    includes: 'relavium chat resume <sessionId>',
    reason: 'the refusal of `relavium chat resume` itself, thrown before any screen exists',
  },
  {
    file: 'commands/chat.ts',
    includes: 'Start one with relavium chat.',
    reason:
      'the refusal of `relavium chat resume --continue` itself, thrown before any screen exists',
  },
  {
    file: 'commands/chat.ts',
    includes: 'chat resume needs a session ID outside an interactive terminal.',
    reason:
      'the refusal of `relavium chat resume` itself on a plain or `--json` run, thrown before any screen exists (the phrase was only looked for with its `relavium` prefix)',
  },
  {
    file: 'commands/chat.ts',
    includes: 'Retry chat resume or return to Home.',
    reason:
      'thrown only where the resume has no owned screen to retry in (`ownership === undefined`: the shell command), so the retry it names is the shell command; the owned path asks in a native card',
  },
  {
    file: 'commands/chat.ts',
    includes: 'start a new `relavium chat` instead',
    reason:
      '`/clear` typed on the plain / `--json` driver, which has no screen to swap (ADR-0049); the interactive chat never reaches it',
  },
  {
    file: 'commands/chat.ts',
    includes: ' — run it with `relavium run ',
    reason:
      "the /export notice of a plain or `--json`-less piped chat: scripted output on stderr, where the shell command is the way to run the file; the interactive chat's notice (`interactive`) names none (OD-20)",
  },
  {
    file: 'commands/chat.ts',
    includes: 'relavium chat — type a message',
    reason: 'the intro line of the plain stdin driver, not a remedy',
  },
  {
    file: 'chat/default-agent.ts',
    includes: 'via `relavium chat`',
    reason:
      "the default agent's SYSTEM PROMPT (read by the model, never drawn), which says how the assistant is run",
  },
];

/**
 * Strings in files this sweep did not own, left for the step that did (Step 2.4 fixed the last ones, so the list is empty). A step that
 * defers a string adds an entry here and deletes it when the string is fixed; the test fails if an entry no longer matches.
 */
const PENDING_ELSEWHERE: readonly Allowance[] = [];

/** Which files may call which command builder, and why. */
const BUILDER_CALLS: Readonly<
  Record<CommandBuilder, readonly { readonly file: string; readonly reason: string }[]>
> = {
  resumeHint: [
    {
      file: 'commands/chat.ts',
      reason:
        'the exit line printed after the chat has closed, and the error text returned after the alternate screen is left',
    },
    { file: 'home/drive-home.tsx', reason: 'the exit line printed after the Home has closed' },
  ],
  relaviumRunCommand: [
    {
      file: 'home/hosted-run-terminal.ts',
      reason:
        'the shell line printed after the Home has closed (`shellRemedy`), and the held-outbox card (only `relavium status` reports it)',
    },
    { file: 'home/run-host.ts', reason: 'the exit facts printed after the Home has closed' },
    {
      file: 'render/tui/final-summary.ts',
      reason: 'the summary printed by the shell after a run view has closed',
    },
    { file: 'run-core/finish-leg.ts', reason: "the shell's own leg epilogue" },
  ],
  humanGateResumeHints: [
    { file: 'commands/logs.ts', reason: "the shell's `logs`" },
    { file: 'commands/status.ts', reason: "the shell's `status`" },
    {
      file: 'render/tui/run-card-model.ts',
      reason: "the input gate's card, which takes no typed value and says 'In a shell:'",
    },
  ],
  budgetResumeHints: [
    { file: 'commands/logs.ts', reason: "the shell's `logs`" },
    { file: 'commands/status.ts', reason: "the shell's `status`" },
    { file: 'render/renderer.ts', reason: "the shell's plain renderer" },
  ],
  resumeCommandBase: [
    { file: 'gate/budget.ts', reason: 'its own definition and the budget hints' },
    { file: 'gate/pending.ts', reason: 'the human-gate hints' },
    { file: 'run-core/resume-run.ts', reason: "the shell's resume leg" },
    {
      file: 'render/tui/final-summary.ts',
      reason: 'the summary printed by the shell after a run view has closed',
    },
    {
      file: 'render/tui/run-card-model.ts',
      reason:
        "the shell-inert test for the card's `gate list` pointer and the input gate's command",
    },
  ],
};

// ── Where each file's strings are shown, for the check that a /command is offered there ────────────────────────────────────

/** The surfaces whose person reads a file's strings, where that is one fixed set; a file not listed is checked for existence only. */
const FILE_SURFACES: Readonly<Record<string, readonly PaletteSurface[]>> = {
  'authoring/global-artifacts.ts': ['home', 'standalone-chat', 'home-chat'],
  'chat/chat-mode.ts': ['standalone-chat', 'home-chat'],
  'chat/effort-notice.ts': ['standalone-chat', 'home-chat'],
  'chat/export.ts': ['standalone-chat', 'home-chat'],
  'chat/repl-info.ts': ['standalone-chat', 'home-chat'],
  'chat/restored-transcript.ts': ['standalone-chat', 'home-chat'],
  'chat/starting-mode-hint.ts': ['standalone-chat', 'home-chat'],
  'commands/chat.ts': ['standalone-chat'],
  'home/provider-setup.ts': ['home', 'standalone-chat'],
  'home/run-launch.ts': ['home'],
  'home/hosted-run-terminal.ts': ['home'],
  // The first-run setup is ONE flow on two surfaces: the Home's native cards and a stand-alone chat's (which has neither `/providers` nor a
  // Home to open it from). A string that names a command is checked against both; the ones that are the Home's alone are said so below.
  'onboarding/setup-notes.ts': ['home', 'standalone-chat'],
  'onboarding/wizard.ts': ['home', 'standalone-chat'],
  'home/run-host.ts': ['home'],
  'render/hatches.ts': ['standalone-chat', 'home-chat'],
  'render/tui/chat-projection.ts': ['standalone-chat', 'home-chat'],
  'render/tui/model-picker-view.tsx': ['home', 'standalone-chat', 'home-chat'],
  'render/tui/pricing-card.ts': ['home'],
  'render/tui/tab-host-agents.ts': ['home'],
  'render/tui/tab-host-sessions.ts': ['home'],
  'render/tui/tab-host-workflows.ts': ['home'],
};

/**
 * One sentence in a file that is read on fewer surfaces than the file as a whole. The `/resume` of the Home-hosted `/clear` notice is
 * the Home's; the stand-alone wording of the same notice says "on the Home" and is checked against the Home by the pointer rule.
 */
const SURFACE_OVERRIDES: readonly {
  file: string;
  includes: string;
  surfaces: readonly PaletteSurface[];
}[] = [
  { file: 'chat/repl-info.ts', includes: '/resume continues it', surfaces: ['home-chat'] },
  // The setup's own sentences for the Home. The stand-alone chat's sentence of each pair names no slash command (it says to restart the
  // chat), so a `/providers` written into THAT one is a failure here, not covered by these.
  {
    file: 'onboarding/wizard.ts',
    includes: 'Add a provider anytime with /providers',
    surfaces: ['home'],
  },
  {
    file: 'onboarding/wizard.ts',
    includes: 'Open /providers to connect a key',
    surfaces: ['home'],
  },
  {
    file: 'onboarding/setup-notes.ts',
    includes: '/providers connects a provider any time',
    surfaces: ['home'],
  },
  { file: 'home/provider-setup.ts', includes: 'Open /providers to retry', surfaces: ['home'] },
];

const names = (commands: readonly { readonly name: string }[]): ReadonlySet<string> =>
  new Set(commands.map((command) => command.name));

/** Every command a surface offers is in its palette list (`/help` too, since MVP-11 Step 2.2). */
const OFFERED: Readonly<Record<PaletteSurface, ReadonlySet<string>>> = {
  home: names(HOME_PALETTE_COMMANDS),
  'standalone-chat': names(REPL_COMMANDS),
  'home-chat': names(HOME_CHAT_PALETTE_COMMANDS),
};

/** Every command any surface has. */
const REGISTRY: ReadonlySet<string> = new Set([
  ...names(REPL_COMMANDS),
  ...OFFERED.home,
  ...OFFERED['standalone-chat'],
  ...OFFERED['home-chat'],
]);

/** A sentence that points at the Home ("on the Home", "from the Home") names its command as the Home's, wherever it is read. */
const POINTS_AT_THE_HOME = /\b(?:the|on the|from the|to the) Home\b/u;

// ── Reading the sources ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** A template head or middle: it is followed by an interpolation, which may complete a command. */
  readonly continues: boolean;
}

interface BuilderCall {
  readonly file: string;
  readonly line: number;
  readonly name: CommandBuilder;
}

interface Scan {
  readonly literals: readonly Literal[];
  readonly calls: readonly BuilderCall[];
}

function isBuilder(name: string): name is CommandBuilder {
  return (COMMAND_BUILDERS as readonly string[]).includes(name);
}

/** The strings and the builder calls of one source text. Comments are not in the tree, so they never count. */
function scanSource(file: string, source: string): Scan {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const literals: Literal[] = [];
  const calls: BuilderCall[] = [];
  const visit = (node: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      literals.push({ file, line, text: node.text, continues: false });
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
      literals.push({ file, line, text: node.text, continues: true });
    else if (ts.isTemplateTail(node))
      literals.push({ file, line, text: node.text, continues: false });
    else if (ts.isJsxText(node) && node.text.trim() !== '')
      literals.push({ file, line, text: node.text, continues: false });
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isBuilder(node.expression.text)
    )
      calls.push({ file, line, name: node.expression.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, calls };
}

/**
 * Directories that hold test harnesses and no product string: they are imported only by `*.test.ts` files, so nothing in them reaches a
 * terminal (the surface matrix and the legend golden mount and record the real surfaces; the words they carry are comments and
 * fixture text about those surfaces, not remedies).
 */
const HARNESS_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'fixtures',
  'surface-matrix',
  'legend-golden',
]);

/**
 * Every module a source file names, read from its syntax tree: a static `import … from '…'`, a side-effect `import '…'`, a re-export
 * `export … from '…'`, a dynamic `import('…')` (a string or an untagged template with no substitution) and `require('…')`. A comment, a
 * string that is not a specifier and a `from '…'` inside prose never count.
 */
function moduleSpecifiers(file: string, text: string): string[] {
  const specifiers: string[] = [];
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const literalText = (node: ts.Node | undefined): string | undefined =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = literalText(node.moduleReference.expression);
        if (specifier !== undefined) specifiers.push(specifier);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalText(node.argument.literal);
      if (specifier !== undefined) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

/** The harness directories a specifier reaches: any path segment of it that is the name of one. */
function harnessDirectoriesIn(specifier: string): string[] {
  const segments = specifier.split('/');
  return [...HARNESS_DIRECTORIES].filter(
    (name) => name !== 'node_modules' && name !== 'fixtures' && segments.includes(name),
  );
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!HARNESS_DIRECTORIES.has(entry.name)) found.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.d\.ts$/u.test(entry.name) &&
      !/\.test\.tsx?$/u.test(entry.name) &&
      !/test-support\.tsx?$/u.test(entry.name) &&
      !/fixture/u.test(entry.name)
    )
      found.push(full);
  }
  return found;
}

const FILES: ReadonlyMap<string, Scan> = new Map(
  sourceFiles(SRC).map((full) => {
    const file = relative(SRC, full).split(sep).join('/');
    return [file, scanSource(file, readFileSync(full, 'utf8'))] as const;
  }),
);

function isShellOnly(file: string): boolean {
  return SHELL_ONLY_FILES.some((entry) =>
    entry.file.endsWith('/')
      ? file.startsWith(entry.file) && !(entry.except ?? []).includes(file)
      : file === entry.file,
  );
}

/** What a literal still says once every allowed piece of it is cut out. */
function withoutAllowed(literal: Literal, allowances: readonly Allowance[]): string {
  let text = literal.text;
  for (const allowance of allowances)
    if (covers(allowance, literal)) text = text.split(allowance.includes).join(' ');
  return text;
}

/** The shell remedies a literal contains, after the allowed pieces are cut out. */
function shellRemediesIn(text: string, continues: boolean): string[] {
  const found = [...text.matchAll(SHELL_REMEDY)].map((match) => match[0]);
  if (continues && DYNAMIC_COMMAND.test(text)) found.push('relavium <built command>');
  return found;
}

// ── The tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('no remedy inside the TUI names a shell command (ADR-0122 §6, ADR-0146 §6, MVP-11 OD-20)', () => {
  const allowed = [...ALLOWANCES, ...PENDING_ELSEWHERE];

  it('finds none in any file whose strings can reach the TUI', () => {
    const violations: string[] = [];
    for (const [file, scan] of FILES) {
      if (isShellOnly(file)) continue;
      for (const literal of scan.literals) {
        const left = withoutAllowed(literal, allowed);
        for (const hit of shellRemediesIn(left, literal.continues))
          violations.push(
            `${file}:${String(literal.line)}  ${hit}  in  ${JSON.stringify(literal.text.slice(0, 100))}`,
          );
      }
    }
    expect(
      violations,
      'a string that reaches the TUI names a shell command: name the TUI action instead (/providers, /models, /pricing, /resume, /doctor, ' +
        '/export, /import, /init, /workflows, /agents, /run, /permissions), or add a reasoned entry to ALLOWANCES',
    ).toEqual([]);
  });

  it('calls a shell-command builder only where its line is a shell line', () => {
    const violations: string[] = [];
    for (const [file, scan] of FILES) {
      for (const call of scan.calls) {
        if (!BUILDER_CALLS[call.name].some((entry) => entry.file === file))
          violations.push(`${file}:${String(call.line)}  ${call.name}(…)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every list honest: no entry for a file that is gone, a string that is gone, or a call that is gone', () => {
    const stale: string[] = [];
    for (const entry of SHELL_ONLY_FILES) {
      const exists = entry.file.endsWith('/')
        ? [...FILES.keys()].some((file) => file.startsWith(entry.file))
        : FILES.has(entry.file);
      if (!exists) stale.push(`SHELL_ONLY_FILES: ${entry.file} does not exist`);
      for (const except of entry.except ?? [])
        if (!FILES.has(except)) stale.push(`SHELL_ONLY_FILES: except ${except} does not exist`);
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
    }
    for (const [list, entries] of [
      ['ALLOWANCES', ALLOWANCES],
      ['PENDING_ELSEWHERE', PENDING_ELSEWHERE],
    ] as const) {
      for (const entry of entries) {
        const scan = FILES.get(entry.file);
        const used = scan?.literals.some((literal) => covers(entry, literal)) ?? false;
        if (!used)
          stale.push(`${list}: ${entry.file} no longer contains ${JSON.stringify(entry.includes)}`);
        else if (isShellOnly(entry.file))
          stale.push(`${list}: ${entry.file} is a shell-only file, so it needs no entry`);
        expect(entry.reason.length, `${entry.file} ${entry.includes}`).toBeGreaterThan(20);
      }
    }
    for (const [builder, entries] of Object.entries(BUILDER_CALLS)) {
      for (const entry of entries) {
        const used = FILES.get(entry.file)?.calls.some((call) => call.name === builder) ?? false;
        if (!used) stale.push(`BUILDER_CALLS: ${entry.file} no longer calls ${builder}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('scans the Home and chat sources: only the files that hold a shell line are exempt', () => {
    const exempt = [...FILES.keys()]
      .filter(
        (file) =>
          (file.startsWith('home/') ||
            file.startsWith('chat/') ||
            file.startsWith('render/tui/')) &&
          isShellOnly(file),
      )
      .sort();
    expect(exempt).toEqual(['chat/resume-hint.ts', 'render/tui/final-summary.ts']);
  });

  it('leaves out the test harness directories only because no product source imports them (a static, side-effect, re-export or dynamic import)', () => {
    const importers = [...FILES.keys()].filter((file) =>
      moduleSpecifiers(file, readFileSync(join(SRC, ...file.split('/')), 'utf8')).some(
        (specifier) => harnessDirectoriesIn(specifier).length > 0,
      ),
    );
    expect(importers).toEqual([]);
  });
});

describe('the harness-import guard sees every way a module is named (it is run on text it is given)', () => {
  const reached = (text: string, file = 'x.ts'): string[] =>
    moduleSpecifiers(file, text).flatMap(harnessDirectoriesIn);

  it.each([
    ['a named import', "import { a } from './x/surface-matrix/y.js';"],
    ['a default import', "import a from '../render/tui/legend-golden/golden.js';"],
    ['a side-effect import', "import './x/surface-matrix/y.js';"],
    ['a type import', "import type { A } from './surface-matrix/y.js';"],
    ['a re-export', "export { a } from './legend-golden/y.js';"],
    ['a star re-export', "export * from './legend-golden/y.js';"],
    ['a dynamic import', "const m = await import('./x/legend-golden/y.js');"],
    ['a dynamic import with a template', 'const m = await import(`./x/surface-matrix/y.js`);'],
    ['a require', "const m = require('./surface-matrix/y.js');"],
    ['an import type node', "type T = import('./legend-golden/y.js').A;"],
    ['an import-equals', "import m = require('./legend-golden/y.js');"],
    ['a directory import with no trailing path', "import { a } from './surface-matrix';"],
  ])('flags %s', (_name, text) => {
    expect(reached(text).length, text).toBeGreaterThan(0);
  });

  it('flags a tsx file the same way', () => {
    expect(reached("import './surface-matrix/y.js'; export const a = <b />;", 'x.tsx')).toEqual([
      'surface-matrix',
    ]);
  });

  it.each([
    ['a comment', "// import './x/surface-matrix/y.js'\nconst a = 1;"],
    ['a string that is not a specifier', 'const a = "from \'./surface-matrix/y.js\'";'],
    ['an ordinary import', "import { a } from './x/y.js'; import('./z.js');"],
    ['a name that only contains a harness name', "import a from './surface-matrix-like/y.js';"],
  ])('does not flag %s', (_name, text) => {
    expect(reached(text), text).toEqual([]);
  });
});

describe('the detector sees what it should (it is run on text it is given, not on the repository)', () => {
  const sourceWith = (text: string): readonly Literal[] =>
    scanSource(
      'x.ts',
      `// relavium chat-export in a comment\nconst message = ${JSON.stringify(text)};\n`,
    ).literals;

  it.each([
    'run `relavium models refresh` to update',
    'Use relavium provider set-key anthropic.',
    'export with `relavium chat-export <id>`',
    'Add one with relavium provider add',
    'Resume with chat-resume',
    'Price it with --input USD_PER_MTOK --output USD_PER_MTOK',
    'Set it with models pricing',
    // The subcommand phrases WITHOUT the `relavium` prefix (they passed unflagged while only the prefixed form was looked for).
    'Store one with provider set-key anthropic',
    'Register it with provider add custom',
    'Continue with chat resume <id>',
    'Write it out with chat export <id>',
    'Update the catalog with models refresh',
    'Set the price with models pricing',
    'Read it in full with gate list <run>',
    'Withdraw them with permissions revoke --all',
    'Start one with `relavium provider set-key openai`',
  ])('flags %j', (text) => {
    const [literal] = sourceWith(text);
    expect(literal).toBeDefined();
    expect(shellRemediesIn(literal?.text ?? '', false).length).toBeGreaterThan(0);
  });

  it.each([
    'Open /models and press Ctrl+R to refresh the catalog',
    'Connect one with /providers',
    'start Relavium without arguments',
    'the price is --input-price and --output-price',
    '~/.relavium/workflows and @relavium/shared',
    'relavium',
    // Prose that merely has the words near each other is not a subcommand phrase.
    'Choose a provider, then add a key',
    'a chat can resume later',
    'the models are refreshed daily',
    'a provider is set with a key',
  ])('lets %j through', (text) => {
    const [literal] = sourceWith(text);
    expect(shellRemediesIn(literal?.text ?? '', false)).toEqual([]);
  });

  it('does not read a comment, and reads a command built from a template', () => {
    expect(sourceWith('plain')).toHaveLength(1); // the comment contributed no string
    const built = scanSource('x.ts', 'const a = `relavium ${name} ${id}`;');
    const flagged = built.literals.flatMap((literal) =>
      shellRemediesIn(literal.text, literal.continues),
    );
    expect(flagged).toEqual(['relavium <built command>']);
  });

  it('reads a builder call and ignores a mere mention', () => {
    const scan = scanSource(
      'x.ts',
      "import { relaviumRunCommand } from './a.js';\nexport { relaviumRunCommand };\nconst a = relaviumRunCommand('logs', id);\n",
    );
    expect(scan.calls).toEqual([{ file: 'x.ts', line: 3, name: 'relaviumRunCommand' }]);
  });
});

describe('every /command a TUI string names exists, and is offered where the string is shown (ADR-0145 §7.4)', () => {
  const surfacesOf = (literal: Literal): readonly PaletteSurface[] | undefined => {
    const override = SURFACE_OVERRIDES.find(
      (entry) => entry.file === literal.file && literal.text.includes(entry.includes),
    );
    if (override !== undefined) return override.surfaces;
    // A sentence that points at the Home names the Home's command, wherever it is read: the pointer rule.
    if (POINTS_AT_THE_HOME.test(literal.text)) return ['home'];
    return FILE_SURFACES[literal.file];
  };

  it('names only commands of the registry, and only ones the surface that shows the string offers', () => {
    const missing: string[] = [];
    const notOffered: string[] = [];
    for (const [file, scan] of FILES) {
      if (isShellOnly(file)) continue;
      for (const literal of scan.literals) {
        // A literal that is the command alone (`'/exit'`, a unit suffix `'/s'`) is a key or a table cell, not a sentence.
        if (/^\/[a-z-]*$/u.test(literal.text)) continue;
        for (const match of literal.text.matchAll(SLASH_COMMAND)) {
          const name = match[1] ?? '';
          const where = `${file}:${String(literal.line)}  /${name}`;
          if (!REGISTRY.has(name)) {
            missing.push(where);
            continue;
          }
          const surfaces = surfacesOf(literal);
          for (const surface of surfaces ?? [])
            if (!OFFERED[surface].has(name))
              notOffered.push(`${where}  (not offered on ${surface})`);
        }
      }
    }
    expect(missing, 'a command that exists nowhere').toEqual([]);
    expect(notOffered, 'a command the surface that shows the string does not offer').toEqual([]);
  });

  it('knows the commands the Home, the chat and the Home-hosted chat offer', () => {
    // The remedies of the sweep, and where each lives (ADR-0146 §6): a failure here means the registry moved under the sentences.
    for (const name of [
      'providers',
      'pricing',
      'resume',
      'import',
      'init',
      'run',
      'workflows',
      'agents',
      'permissions',
      'doctor',
      'models',
    ])
      expect(OFFERED.home.has(name), `/${name} on the Home`).toBe(true);
    for (const name of ['models', 'export', 'doctor', 'permissions', 'compact', 'trim', 'clear'])
      expect(OFFERED['standalone-chat'].has(name), `/${name} in a stand-alone chat`).toBe(true);
    // The Home-hosted chat adds `/resume` to a chat's list; `/providers` and `/init` are the bare Home's (ADR-0145, OD-2), which the
    // pointer rule names in words ("from the Home (/providers)").
    expect(OFFERED['home-chat'].has('resume'), '/resume in the Home-hosted chat').toBe(true);
    // A stand-alone chat has no Home, so none of the Home's own: the pointer rule names the Home in words instead.
    for (const name of ['providers', 'resume', 'pricing', 'import', 'run'])
      expect(OFFERED['standalone-chat'].has(name), `/${name} is not a stand-alone chat's`).toBe(
        false,
      );
  });
});
