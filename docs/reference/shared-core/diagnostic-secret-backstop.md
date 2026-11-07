# Diagnostic secret backstop — the finite shape list

- **Status**: Accepted — the behavior `packages/llm/src/scrub-secrets.ts` implements
- **Canonical home**: the finite secret shapes `scrubSecrets` masks in provider diagnostics (`makeLlmError`'s `message` and `code`) and in the CLI's display sanitizer, and the documented limits of that list
- **Related**: [error-handling.md](../../standards/error-handling.md#diagnostic-secret-backstop) (the rule: a defense-in-depth backstop behind an adapter's own redaction), [built-in-tools.md](built-in-tools.md#finite-diagnostic-credential-masking) (core's journal and display projection, which differs from this list by design), [llm-provider-seam.md](llm-provider-seam.md) (the error model `makeLlmError` belongs to), [../../standards/security-review.md](../../standards/security-review.md)

Moved here from [error-handling.md](../../standards/error-handling.md#diagnostic-secret-backstop) on
2026-11-04, unchanged except the dated LF/TAB `Bearer` limit in **Split and normalized forms**: a PR #96
review found an exact specification in a standard, against the rule that one lives only in its
`docs/reference/` home. The standard keeps the rule and links here.

- **Shapes.** OpenAI/Anthropic `sk-…` and Google `AIza…` key prefixes; a finite list of literal
  secret query names, after `?`, `&` or `#` (an OAuth implicit-flow `#access_token=`); the exact
  `api-key`, `x-api-key` and `x-goog-api-key` header names, also in quoted, JSON-encoded and
  JSON-in-JSON (`\"x-api-key\":\"…\"`) objects; and `Bearer`/`Basic` authentication values. A header
  value may begin with up to eight (possibly quoted, escaped, punctuation-glued or LF/TAB-split)
  `Bearer`/`Basic` labels — a doubled `Bearer Bearer` is a common misconfiguration. Its token may
  begin with any run of (escaped) quotes and ends at a delimiter, at escapes before one, or before a
  nested header name, which then masks its own value. A label may be closed by its own quote before
  its token (`"Bearer" <token>`), and a run of up to eight concatenated labels (`BearerBearer`)
  counts as one label. No label takes as its token another label that whitespace or the end of the
  text follows, even one glued behind punctuation, quoted or concatenated, so a standalone value
  with any number of separately stacked labels masks the token after the last one, and a label glued
  to a token behind a non-word character masks its own token; a second label that other punctuation
  follows (`Bearer Bearer;`) is masked as a token, which only over-masks.
- **Masking.** Every rule, the literal query names included, finds its matches in the original
  text, and the masked ranges of all rules are merged before anything is replaced, so no rule
  can erase the context another rule needs. A header, label or query rule masks only its token:
  the header name, the separator, any labels and the query name stay visible, an LF/TAB-split
  label keeps its spelling, and quotes around a token stay outside it. Masking a token that is
  already exactly `[REDACTED]` changes nothing, so a masked token is a fixed point, quoted,
  escaped or after labels. After a `Bearer`/`Basic` label, text glued to the marker
  (`Bearer [REDACTED];tail`) is masked with it; a header token ends at `,`, `;` or `}`. One
  pass can still glue a marker to the text after another rule's token, so the scrub repeats
  until its output stops changing, at most three passes, and blanks the whole diagnostic if it
  has not settled: a second scrub changes nothing.
- **URL userinfo.** The `?`/`#` rule decides where userinfo ends: a raw `?` or `#` before the
  authority `@` begins public query or fragment text only when the text before it is host-shaped (a
  dotted name or IPv4, `localhost` or a bracketed IP literal, with an optional port, at most 260
  characters in all) **and** an `=` assignment follows it, as in
  `https://host.example?contact=a@b.example`. Masked userinfo that holds such a raw `?` or `#`
  leaves the authority ambiguous: unless a host-shaped name follows its last `@`, the text there may
  be the rest of a query value (`https://svc?password=P@ss`), so the mask runs through the
  authority's end, the next `/`, whitespace, quote, `,` or `}`. The scheme rule then decides what is
  masked: `http(s)`, `ws(s)` and `ftp(s)` mask any userinfo, while the connection-string schemes
  `postgres`, `postgresql`, `mysql`, `mariadb`, `redis`, `rediss`, `mongodb`, `mongodb+srv`, `amqp`,
  `amqps`, `ssh`, `sftp`, `ldap`, `ldaps`, `smtp` and `smtps` mask only colon-bearing userinfo
  (`user:pass@`, `:pass@`), so a bare user such as `ssh://git@host` (or a colonless
  `redis://#TOKEN@host`) stays visible. Userinfo whose password is exactly masked stays as it is:
  beside any username under a connection-string scheme, or beside a masked or empty username under
  any scheme; an empty password, or text glued after a masked one, is still masked. The
  authored-content detector's projection of `postgres://app:{{secrets.password}}@db` to
  `postgres://app:[REDACTED]@db` is therefore a fixed point. Core's journal projection applies the
  same `?`/`#` predicate and also merges its rules' ranges, but masks a userinfo together with the
  values its key and opaque-query rules recognize in it, its username's excepted, each to its own
  end, and ends a value no rule recognizes at the last `@`, whose text after it stays as the host,
  rather than masking through the authority's end
  ([built-in tools](built-in-tools.md#finite-diagnostic-credential-masking)).
- **Split and normalized forms.** Every rule except the literal query names also probes the
  terminal-normalized text; a credential revealed only by normalization masks the **whole**
  diagnostic. The key prefixes, URL userinfo and the exact header names are additionally probed in
  the LF/TAB-joined view at original-text boundaries — of the raw text too when terminal
  normalization changed it, since a terminal sequence there may take a split credential's first
  letter (ESC `A` before `AIza…`) — and a credential revealed only by such a split masks the whole
  diagnostic too. A `Bearer`/`Basic` label may itself be split by LF/TAB, but its opaque value is not
  joined: a value split by an LF or TAB is masked up to the separator and its tail stays visible
  (documented 2026-11-04, after a PR #96 review found the module comment claiming otherwise).
- **Documented trade-offs, all failing closed.** A scheme glued to a word character is masked in
  place; an unlisted scheme ending in a listed one (`gftp://`, `jdbc:mysql://`) matches by its
  suffix; prose that the whitespace-stripped residual probe glues to a path-less URL and a later `@`
  blanks the whole diagnostic, and so does a key prefix (`sk-`, `AIza`) that the same probe joins
  with the following words to its minimum length, at the start of the text or, since the scrub
  repeats, right after another rule's mask (`Authorization: Bearer xyz sk-ant api key invalid`); a
  path-less terminal hyperlink target (OSC 8) that the raw LF/TAB-joined probe joins with a later
  `@` (a hyperlinked table cell before an e-mail address) blanks it as well; a host fragment with no
  assignment (`https://host.example#sec@x`), a single-label host query and an over-long host-shaped
  prefix are masked, and so is the text after the last `@` of such an ambiguous authority unless it
  is host-shaped; a `Bearer`/`Basic` label that ends a line takes the next token with it; an opaque
  value after a label ends only at whitespace, so in compact JSON it masks to the end of the run;
  nine or more concatenated labels, read in the raw text as well as the normalized one, and a token
  that begins with `,`, `;` or `}` after a `Bearer`/`Basic` label in a header value, blank the whole
  diagnostic. Past eight separate labels after a header name, and in a value of labels alone glued
  behind punctuation (`Bearer |Bearer`), the outcome depends on what precedes the header name: when
  its nearest non-whitespace character is a word character, `-` or `_`, the diagnostic stays in
  place (the last label masks any token); otherwise, the start of the text included, it is blanked.
  No token is visible either way, and the output is stable under a second scrub.
- **Limits.** Userinfo under an unlisted scheme is not masked, including driver-qualified spellings
  such as `postgresql+psycopg2://`. Opaque `Bearer`/`Basic` values, `api-key` header values and
  literal secret query values end at any whitespace, LF and TAB included, so a fragment after such a
  break stays visible, as it does after an ordinary space; a label glued to a quoted token without
  whitespace (`Bearer"<token>"`) is likewise outside the shape, as is a token after a JSON escape
  (`\n`, `\t`) that stands for the whitespace after a label. A JSON escape right after a header
  name's colon starts its token, so a value glued to the escape is masked with the escape's letter
  (`"x-api-key":"\n<t>"` → `"x-api-key":"\[REDACTED]"`), while a quoted value behind such an escape
  stays visible (`x-api-key:\t"<t>"`). A terminal sequence with a parameter whose final byte is a
  shape's first letter (ESC `[` `1` `B` before `earer <t>`), and a terminated device-control,
  start-of-string or application-program string (ESC `P`, ESC `X` or ESC `_`, ended by ST or BEL)
  glued before a shape, hide that shape from every view: in the raw text the sequence's last byte
  glues to the shape's first letter, and normalization removes it. A word glued before `sftp://` on
  the same line (`statusftp://user@h`) reads as `sftp`, so its colonless userinfo stays visible like
  any `sftp` user: every whitespace-joined probe, the CLI's display residual among them, glues prose
  to a scheme the same way, and reading it as `ftp` would blank an ordinary
  `connect to sftp://user@host` diagnostic. (A word that ends a line before `ftp://` is no such
  glue: an LF/TAB-split ftp credential after it blanks the diagnostic.) Malformed URLs
  (`https:/u:p@h`), a raw `/` inside a password, invisible characters inside a scheme and JSON whose
  quotes are themselves escaped as `\u0022` are outside the finite shapes. In a JSON-encoded
  diagnostic, an escape written as two characters (`\n`, `\t`, `\r`) and glued before a key prefix,
  a header name or a label defeats that shape's word boundary, so the credential after it stays
  visible (`"key rejected:\nsk-…"`). Core's journal projection shares this limit for key prefixes
  and scheme labels, while core's summary also reads each such escape as its separator and masks the
  credential after it; core's key/value rule's word-character prefix still reads a header or
  secret-key name glued after such an escape (`"err:\napi-key: …"`) and masks the value with it. A header value
  that begins with `,`, `;` or `}` and has no label before it is an empty token, so the text after
  it stays visible. The backstop has no generic key/value rule: a secret key inside a URL authority
  whose value holds `@` — after `;` (`https://svc;a=1;password=P@ss…`), after `&` unless it is one
  of the literal secret query names, or on the next line of a JSON-encoded file whose break is the
  escape `\n` — leaves its value's text after the last `@` visible as the host. Core's key/value
  rule reads that key and masks its value.
