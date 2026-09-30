# CONTEXT.md: domain glossary for opencode-v2-kiro-auth

Vocabulary used by code, tests, and architecture discussions in this repo. Terms are
load-bearing, so use them exactly. This package is an opencode 2.x plugin only. The opencode
1.x plugin is the separate `@hongyilyu/opencode-kiro-auth` package (D9).

## Host boundary

- **Host.** opencode 2.x (`@opencode/cli`), loading the plugin through `@opencode/plugin` 2.x.
  The host owns the chat transport (it sends the request and reads the response), credential
  storage and refresh timing, the retry policy, the merged model catalog, and the built-in
  `websearch` tool. The plugin rewrites the chat exchange. It never sends a chat request itself.
- **Host adapter.** `src/plugin.ts`, the one module that knows the host's plugin API:
  integrations, providers, session hooks, and the web search backend. `src/catalog.ts` shares the
  host's model types. Everything else is host-agnostic and imports no host package. `server.ts`
  is the entry. The host decodes its default export `{ id, setup }`, found through
  `exports["./server"]` for an npm or git install and as `server.ts` by name for a local
  directory, where the loader ignores package.json.
- **Type-only host dependency.** The plugin imports `@opencode/plugin` for types only
  (`bun build server.ts` externals are Node built-ins alone), so the host loads the plugin
  without the package installed beside it. It is an optional peer, pinned as a devDependency
  for typechecking.
- **Rendered request.** `buildChatRequest` in src/client.ts returns the exact URL, header set,
  and body bytes of a `GenerateAssistantResponse` call (`KiroHttpRequest`) without dialing. The
  `http.request` hook hands that to the host to send. The plugin sends the calls the host knows
  nothing about itself, through the same renderer: InvokeMCP web search and the management
  operations behind profile ARNs.
- **Request/response hooks.** Two session hooks, scoped to each provider, rewrite the Anthropic
  exchange. `http.request` replaces the host's Anthropic `Request` with the Kiro one, and
  `http.response` runs every upstream `Response` to a request it rewrote through
  `kiroResponseToAnthropic`. State between them (debug trace, model, context limit) rides a
  WeakMap keyed by the sent `Request` object, which the host passes back unchanged. A response to
  any other request passes through untouched.
- **Catalog model.** What the request hook reads for the requested model from the host's active
  catalog (`ctx.model.list()`, the plugin's defaults plus config overlays): its context limit and
  its declared variant ids. It is looked up by the host's model id (`Model.Ref.id`) first and the
  wire id (`body.model`) second, because a config alias (`modelID` pointing at another id) sends
  the target's wire id but carries its own limits and variants. An unavailable catalog or an
  unlisted model degrades to a
  1,000,000-token window and no variants, and a listed model without a limit gets the same
  window, instead of failing the request.
- **Effort.** The request's `Model.Ref.variant`, forwarded only when the catalog model declares
  it. The host names the unselected variant `"default"`, and Kiro rejects
  `additionalModelRequestFields` on models without variants, so the hook drops an undeclared
  variant. Only `claude-*` ids (adaptive thinking plus `output_config.effort`) and `gpt-*` ids
  (`reasoning.effort`) get fields.
- **OAuth method id.** One OAuth method, id `oauth`. Builder ID vs Identity Center is a form
  answer, and the packed refresh state records which one a credential belongs to. When opencode
  2.x upgrades a 1.x install in place, it imports the `auth.json` OAuth entries under the method
  id `oauth`, so imported credentials stay refreshable. A fresh 2.x database imports nothing.
- **System updates.** opencode 2.x sends mid-conversation `role: "system"` messages (native
  prompt updates, empty effort markers) to newer Claude ids. The history normalizer folds update
  text into the neighbouring user prompt and drops markers before any other pass. It never
  touches tool-result turns.
- **Hook failures.** The host's Promise adapter wraps every plugin hook in `Effect.promise`, so a
  rejection is a defect, not a typed error. An error thrown from the `http.request` hook
  (credential errors `KiroAuthError`/`KiroApiKeyError`, request-shape errors `KiroRequestError`)
  therefore fails the turn with its message, and the runner never retries it: it only retries
  typed provider errors. The plugin registers no `retry` hook. For the same reason a rejected
  `authorize` promise surfaces as HTTP 500 in the CLI, so form `pattern`/`format` carry the
  validation the host can report cleanly.
- **Location.** The host runs one plugin instance per location (`ctx.location`). The request's
  `envState.currentWorkingDirectory` is that location's directory, not the server process's cwd,
  which differs whenever the background service serves a project it was not started in.
- **Retry ownership.** The host sends chat, so retries belong to the host. Its policy classifies
  the status the response seam produced (a 429 or 5xx is retried, a 400 is not) and honours
  `retry-after`. The plugin's only inputs are that status and header. It runs no retry loop of
  its own.

## Wire and transport

- **Kiro wire frame.** One AWS `application/vnd.amazon.eventstream` binary frame.
  `src/eventstream.ts` decodes it into a **KiroEvent** `{ eventType, payload }`. Framing
  only, no interpretation. The decoder is total: it never throws or spins on garbage. The
  spec's three message types collapse into one shape (`:event-type`, `:exception-type`, and
  `:message-type: error` frames, whose `:error-code` / `:error-message` headers fold into an
  `error` event payload). The decoder skips non-string header types by their spec size. Only
  the spec types 0 to 9 exist, so a type above 9 counts as corruption. If Kiro ever emits a vendor
  type, the escape hatch is to skip instead of fault, behind the same bounds checks.
- **Framing fault.** A prelude or header block that lies about its lengths (too short,
  above the spec maximum, or headers larger than the frame), or a stream that ends
  inside a frame. Terminal, because eventstream has no resync marker: the decoder delivers
  frames decoded before the fault and discards everything after. The response driver turns
  it into the same channel as a transport read failure (502 before output, terminal
  SSE error after), so a truncated turn is never recorded as success.
- **KiroStreamEvent.** The *interpreted* form of a KiroEvent, a discriminated union
  produced by `parseKiroEvent` (src/events.ts). Kinds name the behavior we take, not
  Kiro's event namespace: `text`, `reasoning`, `toolUse`, `contextUsage`, `metadata`,
  `rateLimit`, `timeout`, `streamError`, `unknown`.
- **Open-world parse.** `parseKiroEvent` is total and never throws. Any unrecognized
  or malformed event maps to `unknown`, and consumers skip it (counted in `KIRO_DEBUG`
  output). Kiro may add event types freely without breaking us.
- **Preflight.** Reading a 200 response's event stream up to the first real
  output/error before starting the SSE response. `kiroResponseToAnthropic` buffers
  parsed events and hands them directly to the encoder, so it decodes each frame
  once with no byte replay. Kiro hides failures inside HTTP 200 streams, and preflight turns
  pre-output failures into clean HTTP errors (429/504/502/400) that the host retries or
  surfaces. A pre-output generic stream error remains a 200 response with a terminal
  SSE error frame. The seam takes no abort signal, because the host's Promise adapter gives
  session hooks none. Once the body is returned, the host cancels a turn by cancelling that body,
  which cancels the upstream read and emits nothing further. A turn interrupted while preflight is
  still running is invisible to the hook, so the returned body is pull-driven (an unread body reads
  nothing past the preflight buffer) and one the host has not started reading 10 s after the seam
  returned is abandoned: the upstream is cancelled and released. Any other failed read (transport
  rejection or framing fault) is a 502 before output (504 when an opaque transport message reads as
  a timeout) or a terminal SSE `error` frame after it. A failed read of a non-2xx body degrades to
  an empty detail.

## Request mapping

- **KiroRequestPayload.** The typed wire commitment `src/request.ts` emits for
  `GenerateAssistantResponse`. `buildChatRequest` in `src/client.ts` renders it as-is, adding
  only `profileArn` for OAuth sessions. It names only the user and assistant entry shapes we
  produce, not Kiro's full schema. Kiro's tool-result content blocks are text only. A kept image
  inside a `tool_result` moves into the entry's `userInputMessage.images`, and the result text
  gets `[image N attached]` in its place (N counts from 1 across the turn's top-level images
  first). Text blocks map to one `{ text }` each.
- **History normalizer.** The pure request-side operation over copied Anthropic
  messages. It folds system updates, splits mixed retry turns, folds the system prompt,
  degrades invalid tool pairs, and applies image retention in one internally ordered pass
  sequence.
- **Image retention policy.** Only the most recent configured image-bearing turns
  keep image bytes. A turn counts when images are top-level or inside a structured
  `tool_result`. The normalizer rewrites every older image, at either level, to
  `[image omitted]` marker text, so the wire builder never knows whether it kept a turn.
  `KIRO_KEEP_IMAGE_TURNS=0` strips all images, and a blank value counts as unset (default 2).

## Output predicates (deliberately two, because the intents differ)

- **beginsAssistantOutput(e).** "Safe to stop buffering and start streaming."
  Preflight uses it. Reasoning text and KTR signatures count (streaming them
  promptly matters). A bare tool stop frame does not.
- **completesAssistantTurn(e).** "This turn produced a usable assistant turn."
  The encoder's EOF accounting uses it. Only text and *emitted* tool blocks count.
  Reasoning alone never completes a turn, so a reasoning-only stream still errors at
  EOF and the host retries instead of recording a contentless assistant message.

## SSE encoding

- **Anthropic SSE stream.** The `event:`/`data:` stream consumed by the host's Anthropic
  protocol, `@opencode/ai/providers/anthropic`, which both providers register on. The
  **AnthropicSseEncoder** (src/sse.ts), an explicit state machine over KiroStreamEvents,
  produces it.
- **Atomic tool block.** The encoder buffers tool calls (id, name, input fragments) and
  emits each as one complete unit (`content_block_start` + one `input_json_delta` +
  `content_block_stop`) when its stop arrives. A tool block with incomplete
  arguments or no name is unrepresentable. A stream that ends without the stop frame,
  or a call whose name never arrived, emits nothing and falls through to the
  empty-turn error instead of a `{}`-args or nameless tool call. An explicitly stopped
  call with no input fragments goes out with `partial_json: ""`, Anthropic's wire
  shape for zero-parameter tools.
- **Terminal error.** Once the encoder emits an SSE `error` frame, the stream is
  over. Open blocks close, no further frames follow, and a `message_stop` never comes after an
  error. The stream driver routes transport read failures through the encoder, so this
  contract holds on every failure path. Failures after completion emit nothing.
  This matches real Anthropic behavior, where an error event arrives and the stream just ends.
- **Empty-turn error.** The SSE error emitted at EOF when nothing completed the
  turn ("Kiro closed the response stream without assistant output"), so the host
  retries rather than recording a poisoned turn.
- **Refusal stop.** Kiro's `metadataEvent.stopReason === CONTENT_FILTERED`
  (`isContentFilteredStop`, one predicate for both sites). Before output it is a
  non-retryable 400. After output the turn completes normally with
  `stop_reason: "refusal"` and `stop_details { type, category?, explanation? }`, which
  the host's Anthropic protocol maps to a content-filter finish. Otherwise the encoder derives
  `stop_reason` from what it emitted (`tool_use` / `end_turn`), never from Kiro's metadata.
- **Usage estimate.** Kiro reports no token counts. `message_delta` usage takes input
  tokens from the last `contextUsage` percentage times the catalog model's context limit,
  and output tokens from streamed characters (four per token, rounded up).
- **Poisoned turn.** An assistant turn recorded as successful with broken content
  (e.g. a tool call with `{}` arguments). Poison persists, because opencode resends the full
  history and every later request carries it. The Aug 19 2026 incident recorded
  seven of these (`SchemaError(Missing key ["command"])`).

## Reasoning protocol

- **KTR envelope.** Kiro's redacted-reasoning blob, a base64 `redactedContent`
  decoding to a `.KTR~~`-prefixed signature. Replayed opaquely across turns.
- **Omitted-reasoning sentinel.** The single-space thinking delta (`" "`) emitted
  before a signature-only thinking block so opencode keeps the block alive.
  `assistantEntry` maps it back to `""` on replay. Round-trip invariant:
  emit ∘ replay preserves Kiro's original empty form.

## Auth and sessions

- **Device login.** `beginDeviceAuthorization` registers a fresh public AWS SSO OIDC client
  (client name `opencode-v2-kiro-auth`) and starts device authorization.
  `completeDeviceAuthorization` polls until the user approves or the code expires. Builder ID
  uses the fixed Builder ID start URL in us-east-1, and Identity Center takes the start URL and
  region from the form. The plugin never reads kiro-cli's registration or token cache.
- **KiroSession.** The seam consumers use for per-request auth:
  `authHeaders()`, `chatProfileArn()` (undefined for API keys, so chat bodies omit it), and
  `mcpProfileArn()` (always resolves). Both session kinds (OAuth and API key)
  live in src/session.ts, and the Kiro transport client (src/client.ts) is the sole
  consumer of the profileArn methods. `createSession` builds one per request from a
  **SessionSpec**, either `{ mode: "oauth"; accessToken }` or `{ mode: "api"; key }`, which the
  host adapter fills from the credential the host resolved for the provider's integration.
  src/session.ts reads no credential store itself.
- **RefreshState packing.** The entire OAuth refresh state (refresh token, client
  id/secret, region, start URL, method), base64url-packed into opencode's `refresh` credential
  field with the `kiro-oauth-v1:` prefix. opencode's generic storage learns nothing, and
  the credential is self-contained. The prefix versions the blob format, not the host, and the
  opencode 1.x package writes the same format. The blob is credential material, and
  `redactKiroSecrets` redacts it like API keys and bearer tokens.
- **Host-owned refresh.** The host reads the stored credential, decides when it is stale
  (`connection.resolve` refreshes near expiry), and persists the result. The plugin's `refresh`
  only exchanges the packed state for a new credential at AWS SSO OIDC. It is single-flighted per
  stored refresh blob, across every location the process serves (the host runs `setup` once per
  location, but all of them share one credential store), because the host holds no lock around it
  and OIDC may rotate the refresh token, so concurrent requests share one rotation. An expired client registration or an
  unreadable blob is a `KiroAuthError` asking for a new login.
- **API key.** A `ksk_`-prefixed key (`normalizeApiKey`), stored by the `kiro-api` key method or
  read from `KIRO_API_KEY` by its env method. The host prefers a stored key. API-key chat bodies
  omit `profileArn`, and InvokeMCP resolves one with GetProfile, trying the management regions in
  order.
- **Async memo.** `src/memo.ts` is the one bounded, promise-sharing cache behind the
  OAuth profile ARN and the API-key profile ARN. The loader owns the policy. Resolving,
  even to a fallback, caches, and rejecting evicts so the next call retries. A Builder ID 4xx
  from ListAvailableProfiles is an authoritative placeholder answer and stays cached. A 5xx or
  transport failure does not.

## Decisions

- **D1** Two output predicates, not one (see above). Unifying forces either
  buffering all reasoning (TTFB) or accepting reasoning-only turns (poison).
- **D2** Atomic tool blocks over parallel-open blocks (bets on undocumented client
  tolerance) and over reordering (leaks into replay semantics).
- **D3** Mid-stream errors are terminal. The client either ignores a "graceful" stop after an
  error or believes it, and believing it records a truncated turn as success.
- **D4** The parse is open-world (`unknown` variant). Error detection keeps its
  battle-tested string heuristics as implementation detail inside src/events.ts.
- **D5** No unified AuthStrategy interface across OAuth and API key. The acquisition
  flows are irreducibly different and host-schema-bound, and KiroSession is the right
  unification point (`SessionSpec` is a discriminated input, not a strategy). Don't
  re-propose.
- **D6** The response pipeline has one seam (`kiroResponseToAnthropic`). Every
  upstream Response, including non-2xx ones, goes through it. It decodes events
  exactly once, and reader ownership lives in exactly one function. Byte replay is gone
  because it existed only to decouple two halves of one pipeline. HTTP-error
  shaping (body read, redaction, overflow mapping, retry-after policy) lives behind
  the same seam rather than in the `http.response` hook.
- **D7** Request normalization is one pure function over copies. Mutation and pass
  ordering are implementation details. The Anthropic input stays loosely typed at
  the boundary, where defensive checks are the validation, while `KiroRequestPayload`
  is the typed output contract.
- **D8** The eventstream decoder returns a framing fault as a value rather than
  throwing. The return type shows the contract, frames decoded before the
  fault are not lost, and the response driver decides what a fault means.
- **D9** One host per package. This package serves opencode 2.x only, and the opencode 1.x
  plugin stays in `@hongyilyu/opencode-kiro-auth`. The two hosts share no plugin runtime. A 1.x
  module fails the 2.x loader schema, and 2.x has no provider `fetch` override or `config` hook
  (the `http.request`/`http.response` pair takes the intercepting fetch's place). One
  package serving both carried two entries, two adapters, and 1.x-only machinery (intercepting
  fetch, credential manager, auth-file persistence, a plugin search tool) that 2.x never runs.
  The Kiro core and D1 through D8 came over from the 1.x package. The host boundary above is this
  package's own.
- **D10** The plugin ships its own model catalog (`src/catalog.ts`) instead of requiring a
  `providers` block. A plugin-added provider needs models to be selectable at all, and the host
  has no hook to mirror one provider's config onto the other. Config overlays run after plugin
  transforms and win, so users lose nothing. The example config does not repeat the catalog.
- **D11** Web search goes through the host's built-in `websearch` tool rather than a plugin
  tool. The host owns the tool's permission, provider selection, and result rendering, and a
  second `web_search` tool beside it would confuse the model.
