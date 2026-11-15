# Verify macOS write metadata

- **Status**: Contributor procedure for accepted ADR-0127; implementation authorized, source acceptance in progress.
- **Date**: 2026-11-15
- **Related**: [ADR-0127](../decisions/0127-macos-write-metadata-has-distinct-parent-and-file-profiles.md), [canonical profile and acceptance gates](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127), [user troubleshooting](troubleshoot-tool-denials.md)

Use this procedure after implementation authorization to collect real APFS
evidence for the correction. The native contract owns the predicates and limits;
this runbook explains how to obtain and distinguish the evidence. Do not change
an existing user's file, MACL, access policy or OS privacy settings to make a
fixture pass. No actual host/user-interaction acceptance has been performed at
this documentation checkpoint.

## Full host and actual-interaction evidence

1. Record OS version/build, architecture, local APFS volume/profile, actual
   CLI/native source and asset binding, mode and fixture ownership. Obtain an
   operator-approved parent already observed to carry OS-managed MACL. Listing
   its names with `xattr` establishes presence, not its origin; record the
   operator's provenance for the OS-managed fixture. A MACL injected by a test
   is synthetic evidence and cannot replace this case. Keep its value private.
2. Through the actual CLI prepared-write host, create uniquely named controlled
   files directly in that parent. Execute create, overwrite, append and exact
   edit, with real journal wiring and the normal read evidence/approval path.
   The deterministic host harness supplies reproducibility; Home and standalone
   chat provide the presentation checks. A model's claim that it wrote a file
   is not proof of a native publication or a committed receipt.
3. Inspect each published target and compare it privately with the reviewed
   bytes and expected native identity/policy. Record the complete bounded,
   safely escaped visible attribute-name set and equality/outcome facts, without
   copying raw metadata values into receipts or logs. Confirm the parent label
   remains unchanged. Run auto and accept-edits cases with their intended
   approval differences and identical filesystem floors.
4. On a separate host-created controlled text file, record the initial attribute
   names. Ask the operator to open/use that file in a named application and
   close it; record the application/version and interaction, then inspect names
   again. Do not inject `lastuseddate#PS` in this case or assume the application
   necessarily creates it. Attempt and record the full host edit after the
   interaction regardless of which names are observed, including when last-used
   is absent or an unsupported name appears. If the exact last-used name is
   present, retain its value only as private comparison evidence. Record final
   bytes, names, policy equality and journal/user outcomes, distinguishing a
   successful edit from an expected refusal or unresolved effect. Extra
   file-MACL or other unsupported names must be reported as a product limit,
   not silently removed or counted as ordinary-use editing success. An absent
   last-used observation leaves that evidence gate open.
5. Independently run the synthetic attribute, metadata-race, post-rename proof
   fault/crash and refusal controls required by the canonical contract. A final
   target assertion does not replace runtime post-publication verification.
   Confirm failed post-rename proof leaves durable unresolved evidence and no
   successful receipt, automatic retry, rollback or misleading mode remedy.
   Include generic user-attribute suffix rejection before publication, the
   separate unchanged-parent evidence case, and the stored completed payload
   byte length for empty, multibyte and append results. Do not use template size
   zero as the expectation for a nonempty new file.
6. Remove only controlled fixtures whose ownership and outcome are established.
   Retain uncertain stages/journal evidence for the existing recovery process;
   never recursively erase a directory or strip labels to hide a failed case.
   Record unavailable environments/cases as open acceptance gates. Native target,
   artifact and installed-consumer checks remain separately required.

## Performance comparison

Run the checked-in contributor harness from the repository root:

```bash
node tools/native-fs/build.mjs --verify-profile
node tools/native-fs/macos-write-benchmark.mjs baseline
# After the source correction and another source-bound native build:
node tools/native-fs/macos-write-benchmark.mjs corrected
```

The label records a measurement; it does not select an older binary or change
source. The runner checks current source/asset bindings before and after the
complete workload and prints a combined digest. It invokes the real auto policy,
host and registry with the reference in-memory journal, creates only private
controlled temporary fixtures, and retains a failed fixture for inspection.
For a post-change comparison, export the earlier source into an isolated copy
instead of changing the working branch. A rebuilt, pinned earlier native asset
may also be used in an explicitly declared private comparison bundle with the
same host/auto-policy workload. Record that substitution, earlier source and
binary binding separately; it is not the production loader path or an installed
consumer proof. No such baseline selector or fallback is part of the CLI.

Measure the proof itself separately with the declared contributor-only Rust
case from the native crate directory, so Rustup uses its checked-in toolchain
pin (100 measured samples after 10 warmups in each of its four cohorts):

```bash
cd apps/cli/native/fs-metadata
cargo test --release --locked --lib common::macos_publication_tests::bounded_post_publication_proof_timing -- --ignored --exact --nocapture
```

Its fixed records report new/existing and ordinary/dense p50/p95 in nanoseconds.
They measure repeated fresh proof reads on a pinned, already-published controlled
target in a release test binary, including inactive test-hook checks and
excluding N-API and complete-operation latency; the existing-file proof
is shared by overwrite, append and exact edit. No wall-clock CI threshold is
introduced and this ignored timing case does not count as an ordinary profile
parent pass. The explicit execution receipt is required for its measurement.

After implementation authorization, compare baseline and corrected actual host
writes on the same APFS host, volume and dependency/build configuration. Record
both source/asset bindings and filesystem/OS/build context. No benchmark has
been run by this author at the documentation checkpoint; call-count reasoning
alone establishes neither the fastest strategy nor an acceptable measured cost.

Use a deterministic auto-mode host harness with the normal read evidence,
journal, preparation, staging, publication and joined cleanup. Exclude provider
and human approval latency; validate accept-edits behavior separately. Use a
fixed representative reviewed payload (for example 64 KiB) and test create,
overwrite, append and exact edit in each of two supported cohorts: an ordinary
file and a file with 64 bounded opaque suffix-free `user.*` attributes. Record
actual sizes/value lengths and keep all fixtures below the canonical bounds.
The append workload's final payload size must be recorded separately from its
appended delta. Use only controlled fixture paths and safe values.

For every comparable baseline/corrected cell, warm up consistently and collect
at least 100 measured attempts. Report attempted/success/refusal/failure counts,
p50 and p95 successful full-operation latency, sample/percentile method, and
the corrected verifier's separately measured contribution. Keep stage/proof
instrumentation private to the acceptance harness; add no public event or raw
metadata logging. Do not silently discard failures or slow samples. A cell
which cannot complete its intended successful workload has not demonstrated
an acceptable successful-write distribution.

A parent-MACL/last-used case that baseline refuses is a functional compatibility
case, not a baseline successful-write timing. Report it separately; comparing
fast refusal with a completed new write is misleading. Keep cache/warmup,
fixture reset and cleanup conditions comparable, report repeat variance, and
investigate a material p50/p95 regression before acceptance. Do not flush global
caches, change a user's metadata, disable checks or introduce a normal-CI
wall-clock threshold to obtain stable-looking results. Optimize duplicated
work only within a proof cut; the required fresh post-rename reads remain.

## Mechanism probes recorded 2026-11-14

These bounded contributor commands reproduce the mechanisms observed on the
local macOS host on 2026-11-14. They require Python 3 and the macOS system library,
not a product runtime dependency. They do not load the Relavium addon, run a
prepared host write, produce a real user-consent label or certify APFS policy.
Exact OS build details were not captured by those original snippets; do not
retroactively infer them. The outputs below are the dated observations, not a
claim that the commands were rerun on 2026-11-15.

### Subsequent supplied review observations (2026-11-15)

Independent reports supplied by the maintainer state that the synthetic probe
returned all six `True` results and that the empty-child probe completed in a
temporary parent **without** MACL, returning a false MACL-presence result.
That is consistent with the probe's precondition; it does not reproduce the
MACL-bearing-parent case. A report also describes unchanged attribute names
over temporary create/write/rename and a `user.test-content#C` copy-versus-save
observation. These are attributed reviewer observations, not author-executed
adapter tests or new platform/benchmark receipts. No detailed environment or
full raw receipt was supplied for independent binding. Keep the original dated
author record and the reports separate; neither rewrites what was executed in
the earlier author checkpoint or closes the actual-host/real-interaction gates.

### Synthetic last-used metadata copy

The synthetic name was exactly `com.apple.lastuseddate#PS`; its value below is
arbitrary test bytes, not a real usage timestamp. The distinct content checks
ensure that metadata-only copying did not replace either file's bytes.

```bash
python3 - <<'PY'
import ctypes, os, pathlib, tempfile
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.fsetxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
lib.fcopyfile.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
lib.fgetxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
lib.fgetxattr.restype = ctypes.c_ssize_t
lib.xattr_preserve_for_intent.argtypes = [ctypes.c_char_p, ctypes.c_uint]
with tempfile.TemporaryDirectory(prefix='relavium-macos-profile-mechanism-') as root:
    parent = pathlib.Path(root)
    name, value = b'com.apple.lastuseddate#PS', b'synthetic-usage'
    with open(parent / 'source.md', 'x+b', buffering=0) as source, open(parent / 'stage.md', 'x+b', buffering=0) as stage:
        source.write(b'before\n')
        stage.write(b'after\n')
        set_result = lib.fsetxattr(source.fileno(), name, value, len(value), 0, 0)
        copied = lib.fcopyfile(source.fileno(), stage.fileno(), None, 7)
        buf = ctypes.create_string_buffer(len(value))
        read = lib.fgetxattr(stage.fileno(), name, buf, len(value), 0, 0)
        print({
            'setSucceeded': set_result == 0,
            'metadataCopySucceeded': copied == 0,
            'exactOpaqueValuePreserved': read == len(value) and buf.raw == value,
            'sourceBytesUnchanged': os.pread(source.fileno(), 100, 0) == b'before\n',
            'stageBytesUnchanged': os.pread(stage.fileno(), 100, 0) == b'after\n',
            'appleSaveIntentPreserves': lib.xattr_preserve_for_intent(name, 2) == 1,
        })
PY
```

The original command used explicit `0600` `os.open` handles inside its private
temporary directory and also enumerated names on both handles. The reproduction
above uses context-managed handles for cleanup and retains the same six result
checks. All six were `True` in the recorded run; both original name-presence
checks were also `True`. This proves synthetic opaque preservation by that
system API, not genuine last-used creation, a MACL transfer or complete safety.

### Existing parent label and empty-child observation

Run from the chosen parent directory. This bounded probe reads its MACL without
printing the value, creates one empty `0600` child, inspects names and removes
that child. It never sets, clears or copies the parent's label. It is not the
adapter's `0666` template/inheritance test and does not publish content.

```bash
python3 - <<'PY'
import ctypes, os, tempfile
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.fgetxattr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
lib.fgetxattr.restype = ctypes.c_ssize_t
lib.flistxattr.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
lib.flistxattr.restype = ctypes.c_ssize_t
def capture(fd, name):
    size = lib.fgetxattr(fd, name, None, 0, 0, 0)
    if size < 0 or size > 65536:
        return None
    buf = ctypes.create_string_buffer(size)
    return buf.raw if lib.fgetxattr(fd, name, buf, size, 0, 0) == size else None
def names(fd):
    size = lib.flistxattr(fd, None, 0, 0)
    if size < 0 or size > 16384:
        raise RuntimeError('enumeration unavailable')
    buf = ctypes.create_string_buffer(size)
    if lib.flistxattr(fd, buf, size, 0) != size:
        raise RuntimeError('enumeration changed')
    return [name.decode() for name in buf.raw.split(b'\0') if name]
parent = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    before = capture(parent, b'com.apple.macl')
    fd, path = tempfile.mkstemp(prefix='.relavium-macos-empty-probe-', suffix='.md', dir='.')
    try:
        child_names = names(fd)
        after = capture(parent, b'com.apple.macl')
        print({
            'parentMaclReadableAndBounded': before is not None,
            'parentMaclUnchanged': before is not None and before == after,
            'emptyChildAttributeNames': child_names,
            'emptyChildSize': os.fstat(fd).st_size,
        })
    finally:
        os.close(fd)
        os.unlink(path)
finally:
    os.close(parent)
PY
```

Recorded results: `parentMaclReadableAndBounded=True`,
`parentMaclUnchanged=True`, `emptyChildAttributeNames=['com.apple.provenance']`,
and `emptyChildSize=0`. Label equality was measured after child creation,
**before** child cleanup. That does not prove stability across removal or the
behavior of the later stage-to-target rename. Failed or different reproduction
results are not to be normalized into the recorded success.
