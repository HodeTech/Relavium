# Provider conformance harness

This directory contains offline provider fixtures and internal harness helpers. The
[testing standard](../../../../docs/standards/testing.md#per-provider-conformance-tests)
owns the coverage policy; the [W8 plan](../../../../docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-preflight-and-proposed-execution-plan--2026-10-10)
owns staged acceptance. Step 2 adds the strict exchange substrate. The canonical
SDK HTTP scenario matrix and its lowering mutation controls belong to Step 3;
adding this helper alone does not establish that coverage or close CR-81/82.

## Strict expected exchanges

`exchange-replay.ts` is internal: no package barrel export and no vendor SDK
imports. `createExchangeReplay(exchanges)` returns `{ fetch, assertConsumed }`.
Each `ExpectedExchange` contains a statically authored `request: RequestProjection`
and a `response: RecordedResponse`. Author expected request values independently
of production lowering. Do not generate the expected oracle by running the
adapter or by copying a recorder's production request into its expectation.

```ts
const replay = createExchangeReplay([
  {
    request: {
      method: 'POST',
      origin: 'https://provider.example',
      path: '/v1/messages',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: { kind: 'json', value: { model: 'synthetic', messages: [] } },
    },
    response: { status: 200, body: '{"ok":true}' },
  },
]);
// Supply replay.fetch to the adapter's installed SDK transport, exercise the
// scenario, then call replay.assertConsumed() even if the SDK caught a refusal.
```

The projection has these exact rules:

- Native `new Request(input, init)` computes effective Fetch precedence for string,
  URL and Request inputs. `init.headers` replaces inherited headers. Omitted,
  `undefined` and `null` `init.body` inherit a Request's body. A supplied body
  replaces it. Invalid native requests, including URL userinfo, are refused with
  fixed diagnostics.
- Method, origin and path match the effective Request and parsed URL exactly,
  including native Fetch/URL normalization (for example standard method casing,
  host casing, default ports and dot segments). Fragments are excluded because
  they are not sent on the wire.
- `query` is the URL's raw search, including its leading `?` when nonempty. Query
  order, duplicate parameters, separators, encoding and noncredential values
  remain exact. Credential parameters are removed before projection. Names are
  percent/plus decoded, lowercased, then hyphens and underscores are removed.
  The excluded names after normalization are `key`, `apikey`, `xapikey`,
  `accesstoken`, `token`, `authtoken`, `authorization`, `authentication`,
  `password`, `passwd`, `secret`, `clientsecret`, `credential`, `credentials`,
  `signature` and `sig`. Thus `api_key`, `api-key` and encoded variants are
  excluded. Expectations must already contain the credential-free query.
- `headers` contains only `accept`, `content-type`, `anthropic-version`,
  `anthropic-beta` and `openai-beta`. Names are lowercase and values are native
  Headers values, including their trimming/joining. Presence and values of these
  protocol headers match exactly. Authentication, API-key, cookie, user-agent,
  SDK-agent and volatile headers are excluded, even when their values contain
  credentials. Expected header names outside this allowlist are refused.
- `body: { kind: 'none' }` means a null native request body. A present body is read
  from a clone and must be JSON; empty or non-JSON bodies are refused.
  `{ kind: 'json', value: null }` matches the JSON text `null`, independently of
  no body. Object property order is immaterial, but every own property counts,
  including unknown, `__proto__` and `constructor` keys. Array order and length
  count. Numbers must be finite. Expectations refuse undefined, sparse arrays,
  functions, symbols, accessors, nonenumerable properties, nonplain objects and
  cycles rather than silently coercing or stripping them. The outer exchange,
  request, body and response shapes also reject unknown fields.

Expectations are deeply owned and frozen at construction. Each fetch reserves
its ordinal at call entry, before asynchronous body inspection; response order
is the expected call-entry order even if inspections complete in reverse.
Every fetch failure remains sticky, including a caught request mismatch or
extra fetch. `assertConsumed()` refuses that failure, any in-flight fetch, or
unused expected exchanges. An early assertion refusal does not itself poison a
replay: pending or remaining valid calls can still finish. Replay performs no
network calls.

Responses preserve status, optional content type and raw body. Bodyless HTTP
statuses 204/205/304 accept only an empty body, reconstructed with native null
body semantics. Other unrepresentable native Responses are refused.

## Recorder and refusal boundary

`recordExchangeFetch(realFetch)` returns `{ fetch, exchanges }`. It builds one
effective Request, inspects a cloned body, and forwards that same effective
Request to `realFetch` without a second init argument. Authentication and the
native signal remain on the forwarded Request; its body has not been consumed
by inspection. Credentials removed from the projection never enter the stored
request. The response is likewise read from a clone and the original is returned.
Only complete validated successes are retained; a rejected request, network
failure or rejected response creates no partial record. Successful records are
ordered by call entry, including concurrent requests. `exchanges` returns a
frozen snapshot with deeply frozen records, and older snapshots do not grow.

All refusals use `ExchangeReplayError`, with `code: 'exchange_replay'`, a stable
`reason` and a one-based exchange `ordinal`. Reasons are `invalid_expectation`,
`invalid_request`, `invalid_json`, `unsafe_content`, `request_mismatch`,
`over_consumed`, `under_consumed`, `in_flight`, `network_failure` and
`invalid_response`. Messages contain only that reason and ordinal; no mismatch
values, raw URL/body/header dump or external cause are retained. The error is
frozen so catching it cannot alter a subsequent assertion's diagnostics.

Stored values are checked with the shared `looksLikeSecret` heuristic. Request
JSON and valid JSON responses (including valid SSE `data:` JSON records) also
refuse nonempty string values under the credential names above, except
`signature`/`sig`, which can be legitimate thinking-continuation protocol data.
Secret-shaped signatures still fail the scanner. URL path/query values are
checked decoded as well as in stored form; protocol-header values and response
content types are checked too. Excluded authentication headers and named
credential URL parameters are intentionally forwarded without being retained.
Planted-secret regressions cover both refusals and exclusions.

This is a synthetic fixture safeguard, not proof that arbitrary provider or user
content is secret-free. Pattern scanning cannot recognize every opaque secret,
encoding or credential-bearing field, and non-JSON response text receives only
pattern checks. Do not treat this recorder as permission to publish arbitrary
live traffic. The existing `replay.ts` response-only helpers and the genuine
[W7 overflow artifacts](fixtures/overflow/README.md) remain separate and unchanged
in format and bytes; the new exchange oracle does not rewrite them.
