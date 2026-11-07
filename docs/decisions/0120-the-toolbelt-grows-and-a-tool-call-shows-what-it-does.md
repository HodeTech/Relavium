# ADR-0120: The toolbelt grows, and a tool call shows what it does

- **Status**: Proposed
- **Date**: 2026-11-05 (revised 2026-11-06 after the PR #97 review)
- **Related**: [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md), [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [phase 2.6 · 2.6.M](../roadmap/phases/phase-2.6-conversational-authoring.md#26m--the-first-class-toolbelt-breadth--rendering), [MVP-A8, MVP-A9](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)

## Context

The registry has no way to edit part of a file, search file contents or find
files by pattern. `write_file` replaces a whole file, and its approval card
shows **no preview** of what will be written. In `auto` mode the write leaves no
visible trace at all (#305).

The transcript's tool rows also lose information:

- A row shows ✓ even when the call failed.
- The row's target disappears when the turn ends.
- The assistant's text between tool calls is dropped.

Since 2.5 the posture has been **never render tool arguments**. That rule kept
model-chosen strings off the terminal, but it now blocks the one thing an
approval needs: showing the user what they are approving.

[ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
makes the user's diff review the control that stands between a prompt-injected
model and the disk, so the review surface has to exist and has to be
trustworthy.

Phase 2.6 ADR row 9 bundled three things: the toolbelt additions, this
render/approval-preview contract, and `ask_user`'s mid-turn pause. On 2026-11-04
the maintainer split it. The first two land with MVP-3. `ask_user`, which
rides the engine's pause machine, gets its own ADR later.

## Decision

**We add the editing, searching and finding tools under the existing
governance floor. We replace "never render arguments" with a closed,
per-tool preview contract: a tool renders only what its definition declares
previewable, every rendered string passes the sanitization floor, and every
truncation is stated.**

### 1. Toolbelt additions

Every tool below is engine-pure: Zod arguments, `llmVisibleParams`, a policy
class and bounded results. Each sits under the jail, the protected-path floor
and the confidentiality floor, and is selectable in agent and workflow YAML.
Exact arguments, bounds and texts live in
[built-in-tools.md](../reference/shared-core/built-in-tools.md).

- **`edit_file`.** Replaces an exact old string with a new one, either a unique
  occurrence or `replace_all`. It is `fsWrite`-governed.
  - **Read before edit.** It refuses a file the session has not read, or one
    whose content changed since that read, so an edit never applies to a view
    the model did not see.
  - The write is atomic and preserves line endings. Binary files are refused.
- **`search_files`.** Searches file contents.
  - The pattern is a **literal** (with case and whole-word options), never a
    regular expression, so there is no backtracking surface.
  - It respects ignore files, skips binary files and never searches a
    confidentiality-floor path.
  - It is bounded in files scanned, matches and bytes per line. It is
    idempotent and not governed.
- **`find_files`.** Finds files by glob with the in-house matcher. Results are
  sorted by mtime and bounded. It respects ignore files and never lists a
  confidentiality-floor path. It is idempotent and not governed.
- **`read_file` ranges (MVP-A9).** `read_file` takes a line or byte range.
  - A result over the model-facing ceiling spills to the session's **output
    store**, as the tool-result bounding contract already defines for runs.
  - Chat now wires that store. It is private to the operator, scoped to the
    session, and removed when the session ends. Orphans left by a crash are
    swept at the next start.
  - It is never `history.db`, so ADR-0095's no-tool-content-at-rest invariant
    holds.
  - The tool's model-visible description states the binary refusal it enforces.
- **No silent caps.** Every bounded result says it was bounded and by how much.
  That includes `list_directory`'s 200-entry cap, which today truncates
  silently.

### 2. The preview contract

- **Each tool declares what may be shown.** A tool definition declares a
  **preview function**. It is a pure function from the validated arguments
  (and, for a write, the host-prepared before and after content) to a typed
  `ToolPreview`:
  - a **target**: the path, the argv, or the method and host;
  - zero or more named **fields**;
  - an optional **diff**.

  A tool that declares none shows its name only. A field marked secret, a
  `credentialRef` or a masked input is structurally absent from `ToolPreview`'s
  type. It cannot be declared previewable.
- **Every string passes the floor.** In a transcript row, each target and
  field passes `sanitizeUntrusted`: secret shapes masked on the original text,
  then terminal controls stripped. Each is bounded per field and per row. A
  target is one line (`sanitizeInline`).
- **An approval preview is built not to hide what it approves.** Stripping is right for a
  transcript row and wrong for an approval: an edit that adds an escape or a
  bidi override would render exactly like the original. A code point a terminal
  draws as nothing, or as a blank, hides content the same way: a tag-character
  run (U+E0000–U+E007F) can spell a whole instruction in zero columns; a
  zero-width or no-break space inside a compared literal stops it matching; and
  U+2028 or U+2029, which JavaScript reads as a line break and a terminal draws
  as nothing, ends a `//` comment without ending the line on screen. So in an
  approval card and its full view, every code point in a target, field or diff
  line that is not a printable graphic character renders as a visible, styled
  escape (for example `<U+202E>`, `<U+2028>` or `<U+E0049>`), never stripped and
  never left invisible. A literal `<U+` already in the text is escaped too (its
  `<` shows as `<U+003C>`), so the notation stays unambiguous where styling is
  off. The set is defined by properties, with one short hand-kept list:
  - every `\p{C}` code point: controls, format characters, surrogates,
    private-use and unassigned code points;
  - every separator other than the ASCII space (`\p{Z}`): the other spaces and
    the line and paragraph separators;
  - every default-ignorable code point (`\p{Default_Ignorable_Code_Point}`),
    which covers the joiners, variation selectors and fillers a transcript
    keeps, so an approval shows `<U+FE0F>` rather than hide a code point;
  - the graphic code points known to draw as a blank or as nothing: U+2800 (the
    braille blank), U+16FE4 (a filler mark) and U+1D159 (a null notehead). A
    font can draw others blank; the mandatory security review owns this list.

  A TAB shows as a styled tab mark instead, so tab-indented code stays readable
  and a tab is still told from spaces. Whitespace at the end of a line, the
  ASCII space included, shows as a styled mark per character (`·` for a space),
  as `git diff` marks whitespace errors, so a trailing space never draws as
  nothing. A CR before an LF is part of the line's ending, not trailing
  whitespace. The line diff compares each line with its ending. The card states
  each side's endings whenever they are not all LF (a styled `CR LF endings` or
  `mixed endings` note beside the target, always shown for a new file whose
  lines end in CR LF), and a line whose ending differs from its side's or from
  the other side's shows a styled `<CR LF>` or `<LF>` mark. A CR anywhere else is
  escaped. A change to whitespace or to a line ending alone therefore never
  renders as an unchanged line, and a file written in CR LF never looks like its
  LF twin. The property sets are ones the JavaScript regular-expression engine
  knows, so only the short blank-drawing list above is kept by hand. The escape
  does not tell confusable letters apart (a Cyrillic `а` for a Latin `a`), and it
  does not stop visible right-to-left letters from being drawn right to left:
  both are visible, and they stay as they are. Transcript rows may
  strip. The order is fixed: secret masking on the original text, then this
  escape, which turns every such code point into printable text, and only then
  the card's plain drawing: ADR-0114's sanitize step, whose strip then finds
  nothing to remove, with no markdown parse (ADR-0114 §5 keeps tool rows plain).
  The diff's two sides go through the same escape.
- **A mask hides a secret's value, never what the call does.** A span the secret
  masking replaces shows as a labelled mask with its length, and the card states
  how many spans were masked. The masker matches shapes, and a model chooses
  what fills them: `Bearer $(curl …|sh)` is masked like `Bearer sk-…`. So a
  masked span that holds anything other than credential characters (letters,
  digits and `-_.+/=~:`), such as whitespace, `$`, a quote, a bracket, a
  backquote, `;`, `|`, `&`, `<` or `>`, is flagged on the card, and while any
  span is flagged the approving answers stay disabled until the user reveals the
  masked spans in the full view with a deliberate key. The full view unmasks only
  on that key. Approving approves the bytes the host will write, masked spans
  included, and the card says so. Whether a write whose changed lines are wholly
  masked may be approved at all is for the mandatory security review.
- **These rules are a starting set, not a proof.** Each closes a way an approval
  was shown to hide content while this draft was reviewed: zero-width and tag
  runs, the line separators, line-end whitespace and endings, and code inside a
  mask. This ADR claims only the rules it states. Whether they are complete
  (other code points a font draws blank, a terminal's own rendering, anything
  else that makes two different approvals look the same) is for the mandatory
  security review before MVP-3 builds the card, which confirms or extends them;
  until it has ruled, no wider guarantee is made.
- **Diffs are in-house.** A diff is a line diff computed in-house, with no
  dependency.
  - It is computed over the **same bytes the host will write**. The write
    refuses if the file changed between the preview and the write, so what was
    approved, with controls escaped and masks labelled, is what lands.
  - Its rendering adapts to the terminal width (stacked or side by side), and
    each side passes the floor.
- **Truncation is stated, never hidden.** A preview that does not fit shows the
  hidden line and byte counts, and the full view is one key away from the
  card. The engine never renders; the CLI draws a `ToolPreview` as plain spans
  through ADR-0114's sanitize and layout, with no markdown parse, and writes no
  escape sequences.

### 3. Where previews appear

- **Approval cards.**
  - **Writes and edits** show the target and the diff.
  - **Commands** show ADR-0118's exact argv card.
  - **Every other governed tool** shows its target and declared fields.

  Answering keys stay ADR-0057's unmodified-key set.
- **Transcript rows** (MVP-A8):
  - The row keeps its **sanitized target** after the turn ends.
  - Its mark tells the truth: success, failure, denial, or outcome unknown
    (ADR-0119).
  - The assistant's text between tool calls stays in place.
  - A write in `auto` mode, which shows no card, leaves a row with its target
    and diff stats. A write is never silent.
- **Details.** A details view showing the full declared preview and a bounded
  result summary is part of this contract. Whether it ships with MVP-3 or after
  is a scope call recorded in the phase file.
- **Never at rest.** Previews are display state computed live. They are never
  persisted. After a resume, the repaint shows each call's name and its
  ADR-0095 structure, not its target. A target is a tool argument, and arguments
  stay off disk.

### Alternatives considered

- **Keep never-render and approve blind.** Rejected. ADR-0116 makes the user's
  review a security control. A control the user cannot see is not a control.
- **Render the raw arguments.** Rejected. That would show model-chosen strings
  with no declaration of what is safe to show, and secret-bearing arguments
  could reach the terminal.
- **A regular-expression `search_files`.** Rejected. A model-supplied pattern
  is a ReDoS surface. A literal search covers the common need, and a bounded
  pattern language can come later through its own review.
- **A diff library.** Rejected under the dependency rule. A line diff over
  bounded input is small enough to own.
- **Persist targets so a resume shows them.** Rejected. A target is a tool
  argument, and ADR-0095 keeps arguments off disk.

## Consequences

### Positive

- The agent can make surgical edits, search and find in the tree, and read
  large files in ranges.
- Every governed call the user approves is shown through the rules above, which
  are built so that what it will do is visible; their completeness is the
  security review's to confirm. In particular, every write shows its diff, and
  every `auto` write leaves a trace.
- Tool rows tell the truth about outcomes, and the conversation's own text
  between tool calls survives.
- The "what may be rendered" question has one typed answer per tool. A new tool
  shows nothing until it declares a preview, so the default stays closed.

### Negative

- The never-render posture is gone. Its replacement is a contract that every
  new tool must implement correctly, and a mistake in a preview function is now
  a display bug with security weight. The mandatory security review covers the
  preview functions, the diff, truncation and the write's
  preview-equals-written check.
- `edit_file`'s read-before-edit rule needs per-session read bookkeeping.
- The output store adds session-scoped files on disk, with their own sweep.
- A resumed session shows less than the live one did, by design.
