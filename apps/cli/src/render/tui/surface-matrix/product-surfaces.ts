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
  ['model-picker', 'the /models picker'],
  ['sheet-permissions', 'the docked /permissions sheet'],
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
  ['settings-effort', 'the /effort popup: the tiers of the bound model, the one in force marked'],
  [
    'settings-form',
    'a form popup: the test layer’s tabs, radio group and warning (the body of the /models second step)',
  ],
  [
    'settings-effect',
    'a list popup whose highlighted row states its effect: the test layer’s (the body of the /mode first step)',
  ],
];

export const PRODUCT_SURFACES: readonly ProductSurface[] = [
  // The Home: the landing in each of its states.
  row('home.empty-keyless', 'the empty Home with no provider key (first run)'),
  row('home.empty-keyed', 'the empty Home with a provider key'),
  row(
    'home.populated-parked-run',
    'the populated Home with a parked run, a failed run, conversations and agents',
  ),
  row('home.strip-focus', 'the populated Home with a strip row focused (the ↓ flow)'),
  row(
    'home.strip-focus-parked',
    'the populated Home with the parked run focused (the ↓ flow on an Attention row)',
  ),
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
  row('home.native-provider-list', 'the provider setup’s list of providers'),
  row('home.native-key-step', 'the provider setup’s key step'),
  row('home.native-env-consent', 'the provider setup’s consent to an environment key'),
  row('home.native-keychain-card', 'the provider setup’s card for an unavailable keychain'),
  row('home.native-failed-check-card', 'the provider setup’s card for a key the provider refused'),
  row('home.model-picker', 'the /models picker'),
  row('home.mode-flow', 'the /mode flow'),
  row('home.pricing-card', 'the /pricing form and its card'),
  row('home.import-card', 'the /import path field and its card'),
  row('home.export-card', 'the Defined tab’s export card'),
  row('home.init-card', 'the /init card'),
  row('home.resume-picker', 'the /resume picker'),
  row('home.run-launch', 'the /run picker, form and confirmation'),
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
  'home.run-launch':
    'the /run flow (picker, input form, confirmation) is built inside driveHome over the engine and the run host; there is no injection seam short of an engine',
  'home.first-run-setup':
    'the setup that opens itself is driven by driveHome from the renderer-ready callback and the keyless read; its cards are covered through the provider setup rows, the self-opening path needs driveHome',
  'run-app.live':
    'the `relavium run` renderer (`RunApp` over a `RunStore`) is a fourth host the harness does not mount; its frame is the Home run view’s body, which is covered',
};
