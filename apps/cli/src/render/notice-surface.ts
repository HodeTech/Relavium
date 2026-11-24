/**
 * Where a notice is read, because that decides which remedy exists (MVP-11, [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6
 * and [ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §6, OD-20).
 *
 * `shell` is scripted output (`relavium run`, `agent run`, `gate`, `list`, a plain or `--json` chat): a subcommand can be named there
 * ([ADR-0122](../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §6). `tui` is the interactive chat and the Home: a remedy
 * there names an action the surface has (`/models`, `/pricing`, `/import`), never a shell command. The default is `shell`, so a caller that has
 * not chosen keeps the scripted wording, and it is the TUI hosts that say `tui`. ONE type for every notice that has two wordings.
 */
export type NoticeSurface = 'shell' | 'tui';
