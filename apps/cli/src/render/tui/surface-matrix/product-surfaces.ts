/**
 * Every surface of the interactive CLI, in one hand-kept table: the completeness test fails when a row is neither mounted by the matrix nor
 * listed with its reason in {@link NOT_COVERED_YET}, when a mounted surface is not a row, and when a row is both. A new surface is
 * added here in the commit that adds it, so the matrix is never silently behind the product.
 *
 * Scope: the Ink screens of the interactive product, in the three hosts the matrix mounts: the Home (`home.*`), the chat the Home hosts
 * (`chat.*`) and the stand-alone chat, `relavium chat` (`standalone-chat.*`). The plain, `--json` and one-shot drivers draw no screen
 * and the `clack` prompts of the authoring commands are not Ink; neither is a surface of this table.
 */
export interface ProductSurface {
  /** `<host>.<name>`. */
  readonly id: string;
  readonly title: string;
}

const row = (id: string, title: string): ProductSurface => ({ id, title });

/** The surfaces a chat has, once for each of its two hosts: the same `ChatView`, cards and sheets under two input owners. */
const CHAT_ROWS: readonly (readonly [string, string])[] = [
  ['idle', 'the idle chat prompt'],
  ['running-turn', 'a running turn: the streamed answer and the live line'],
  ['palette', 'the / palette, laid out upwards from the prompt'],
  ['settings-models', 'the /models popup: the catalog, the bound model marked'],
  [
    'settings-models-apply',
    'the /models popup’s second step: the effort, where it applies and where the conversation goes',
  ],
  [
    'permissions-list',
    'the /permissions popup: the remembered commands and the session’s approvals',
  ],
  ['permissions-armed', 'the /permissions popup: a withdrawal’s line, answered by Enter'],
  ['permissions-empty', 'the /permissions popup: nothing remembered and nothing approved'],
  ['mode-prompt', 'the /mode flow’s native card (the startup default)'],
  ['approval-file-edit', 'the approval card of a file edit'],
  ['approval-command', 'the approval card of a command'],
  ['question-card', 'the agent’s question card (ask_user)'],
  ['continue-checkpoint', 'the continue checkpoint card'],
  ['full-view', 'the approval card’s full view'],
  ['details-list', 'the /details list of tool calls'],
  ['details-view', 'one tool call in the details view'],
  ['mention', 'the @-mention file completion'],
  ['reverse-search', 'the Ctrl+R reverse search'],
  ['reasoning-panel', 'the expanded reasoning panel'],
  ['popup', 'a popup: the test layer’s minimal report popup in the one overlay slot (ADR-0148)'],
  [
    'popup-rich',
    'a popup over a chat with markdown, a tool row and a draft: the backdrop-dim body (ADR-0148 §4)',
  ],
  ['doctor-checks', 'the /doctor popup: the quick tier’s checks'],
  ['doctor-line', 'the /doctor popup: the deep tier’s confirmation line'],
  ['doctor-done', 'the /doctor popup: the deep result with the session’s MCP rows'],
  ['report-agent', 'the /agent popup: the bound agent’s fields'],
  ['report-cost', 'the /cost popup: the report with nothing held'],
  ['report-cost-held', 'the /cost popup: a held estimate and the release control'],
  ['report-cost-release', 'the /cost popup: the release’s confirmation line'],
  ['report-cost-done', 'the /cost popup: the release’s result'],
  ['report-cost-loading', 'the /cost popup: the session cost being read'],
  ['report-cost-error', 'the /cost popup: the session cost could not be read'],
  ['report-workflows', 'the /workflows popup: the project’s catalog'],
  ['report-workflows-empty', 'the /workflows popup: an empty project'],
  ['report-workflows-loading', 'the /workflows popup: the catalog being read'],
  ['report-workflows-error', 'the /workflows popup: the catalog could not be listed'],
  ['report-help', 'the /help popup: the commands and keys of a chat'],
  ['export-confirm', 'the /export confirmation popup: the file it writes, and the review sentence'],
  ['settings-effort', 'the /effort popup: the tiers of the bound model, the one in force marked'],
  [
    'settings-form',
    'a form popup: the test layer’s tabs, radio group and warning (the body of the /models second step)',
  ],
  [
    'settings-effect',
    'a list popup whose highlighted row states its effect: the test layer’s (the body of the /mode first step)',
  ],
  ['settings-mode', 'the /mode popup: the modes, the one in force marked, its effect stated'],
  [
    'settings-mode-apply',
    'the /mode popup’s second step: where the mode applies, its effect stated before Enter',
  ],
];

export const PRODUCT_SURFACES: readonly ProductSurface[] = [
  // The Home: the landing in each of its states.
  row('home.empty-keyless', 'the empty Home with no provider key (first run)'),
  row('home.empty-keyed', 'the empty Home with a provider key'),
  row(
    'home.empty-title',
    'the empty Home with `show_banner = false`: the one-line title instead of the block',
  ),
  row(
    'home.populated-parked-run',
    'the populated Home’s landing: its indicator counts a parked run, a failed run and conversations',
  ),
  row('home.strip-focus', 'the work page with a row focused (the ↓ flow)'),
  row(
    'home.strip-focus-parked',
    'the work page with the parked run focused (the ↓ flow on an Attention row)',
  ),
  row('home.work-prompt', 'the work page with its docked prompt focused'),
  row('home.work-palette', 'the / palette on the work page, above the docked prompt'),
  row('home.loading', 'the Home while a chat is being built'),
  row('home.palette', 'the / palette on the landing'),
  row('home.help', 'the /help screen'),
  row('home.notice', 'a command’s one-line answer as the Home’s notice'),
  // The `/doctor` popup (ADR-0148 §8), in each of its states.
  row('home.doctor-checks', 'the /doctor popup: the quick tier’s checks'),
  row('home.doctor-detail', 'the /doctor popup: a row’s detail step'),
  row('home.doctor-line', 'the /doctor popup: the deep tier’s confirmation line'),
  row('home.doctor-running', 'the /doctor popup: the deep tier running'),
  row('home.doctor-done', 'the /doctor popup: the deep result, with its age'),
  row('home.doctor-empty', 'the /doctor popup: a confirmation line with nothing to send'),
  row('home.doctor-error', 'the /doctor popup: checks that could not run'),
  // The screens of the slot: the tab host and the run view.
  row('home.tab-defined', 'the Defined tab'),
  row('home.tab-active', 'the Active tab'),
  row('home.tab-history', 'the History tab'),
  row('home.run-detail', 'the History tab’s run detail'),
  row('home.node-detail', 'the node page of a run’s detail'),
  row('home.tab-agents', 'the Agents tab'),
  row('home.tab-sessions', 'the Sessions tab'),
  row('home.tab-permissions', 'the Permissions tab'),
  row('home.run-view', 'the run view of a hosted run'),
  // The cards of a run.
  row('home.gate-card', 'the gate card of a parked run'),
  row('home.gate-card-list', 'the gate card of a run parked at two gates (the list of gates)'),
  row('home.budget-card', 'the budget card of a parked run'),
  row('home.mcp-consent-card', 'the MCP consent card'),
  row('home.exit-guard', 'the exit-guard card'),
  // The native prompt cards of the provider setup, and the flows of the Home's commands.
  row('home.provider-first-run', 'the first-run setup popup’s first step (skip for now)'),
  row('home.native-provider-list', 'the provider setup’s list of providers'),
  row('home.native-key-step', 'the provider setup’s key step'),
  row('home.native-env-consent', 'the provider setup’s consent to an environment key'),
  row('home.native-keychain-card', 'the provider setup’s card for an unavailable keychain'),
  row('home.native-failed-check-card', 'the provider setup’s card for a key the provider refused'),
  row('home.provider-done', 'the provider setup popup’s Done step'),
  row(
    'home.provider-done-failed',
    'the provider setup popup’s failed Done step (the key checked out and was not saved)',
  ),
  row(
    'home.settings-models',
    'the /models popup on the bare Home: the catalog, the default marked',
  ),
  row(
    'home.settings-models-apply',
    'the /models popup’s second step on the bare Home: the effort of the default of new chats',
  ),
  row('home.mode-flow', 'the /mode flow'),
  row('home.pricing-card', 'the /pricing form and its card'),
  row('home.import-card', 'the /import path field and its card'),
  row('home.export-card', 'the Defined tab’s export card'),
  row('home.init-card', 'the /init card'),
  row('home.init-done', 'the /init popup’s Done step (what was created)'),
  row('home.init-done-failed', 'the /init popup’s failed Done step (the write was refused)'),
  row('home.init-refused', 'the /init popup’s refusal step (a folder that cannot be a project)'),
  row('home.import-path', 'the /import popup’s first step: the path field'),
  row('home.import-done', 'the /import popup’s Done step (what was imported)'),
  row('home.import-done-failed', 'the /import popup’s failed Done step (the write was refused)'),
  row('home.pricing-rates', 'the /pricing popup’s rates: the first price field'),
  row('home.pricing-done', 'the /pricing popup’s Done step (what was recorded)'),
  row('home.pricing-done-failed', 'the /pricing popup’s failed Done step (the write was refused)'),
  row('home.export-done', 'the Defined tab’s export popup’s Done step'),
  row('home.export-done-failed', 'the Defined tab’s export popup’s failed Done step'),
  row('home.resume-picker', 'the /resume popup: its session picker'),
  row(
    'home.resume-restore',
    'the /resume popup: the retry question of a history that could not be read',
  ),
  row('home.run-launch', 'the /run popup: its confirmation, the chord step'),
  row('home.run-launch-secret', 'the /run popup: a masked input after a resize cleared it'),
  row('home.first-run-setup', 'the first-run setup that opens itself'),
  // The popup (ADR-0148): the frame every user-started report, setting and flow will wear, opened by the test layer until a command is one.
  row(
    'home.popup',
    'a popup: the test layer’s minimal report popup in the one overlay slot (ADR-0148)',
  ),
  row(
    'home.popup-populated',
    'a popup over the populated landing: its strip and its attention row (the backdrop-dim body, ADR-0148 §4)',
  ),
  row(
    'home.popup-selected-row',
    'a popup over the populated landing with a strip row selected (an inverse row; the backdrop-dim body, ADR-0148 §4)',
  ),
  // The card of a run whose log cannot be read: a read-only popup, opened by Enter on its row of the work page (MVP-11 unit 7).
  row(
    'home.unreadable-run-card',
    'the card of an unreadable run: why its log cannot be read, read-only (over the work page)',
  ),
  // A prompt of the native prompt channel drawn in the popup frame (MVP-11 unit 6, 6.1): the frame every flow of the Home wears.
  row('home.native-popup-select', 'a native choice drawn in the popup frame (a hint that wraps)'),
  row('home.native-popup-text', 'a native text field drawn in the popup frame'),
  row(
    'home.native-popup-password',
    'a native masked field drawn in the popup frame, after a resize cleared it',
  ),
  row('home.native-popup-busy', 'a native wait drawn in the popup frame'),
  row('home.native-popup-chord', 'a native chord step drawn in the popup frame (facts that wrap)'),
  row('home.native-popup-picker', 'the native session picker drawn in the popup frame'),
  row('home.native-popup-done', 'a flow’s persistent Done step drawn in the popup frame'),
  // The chat, in both of its hosts.
  ...(['chat', 'standalone-chat'] as const).flatMap((host) =>
    CHAT_ROWS.map(([name, title]) =>
      row(`${host}.${name}`, `${title} (${host === 'chat' ? 'in the Home' : 'stand-alone chat'})`),
    ),
  ),
  row('run-app.live', 'the run renderer of `relavium run`'),
];

/**
 * The rows the matrix cannot mount yet, each with the seam that is missing. The list only shrinks: a row that is mounted is removed from
 * it in the same commit (the completeness test fails otherwise), and a later step that adds a seam deletes its entry.
 */
export const NOT_COVERED_YET: Readonly<Record<string, string>> = {
  'home.first-run-setup':
    'the setup that opens itself is driven by driveHome from the renderer-ready callback and the keyless read; its cards are covered through the provider setup rows, the self-opening path needs driveHome',
  'run-app.live':
    'the `relavium run` renderer (`RunApp` over a `RunStore`) is a fourth host the harness does not mount; its frame is the Home run view’s body, which is covered',
};
