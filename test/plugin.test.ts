import { describe, expect, it } from "bun:test"
import type { Credential } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import { decodeRefreshState, encodeRefreshState, KiroAuthError } from "../src/auth"
import { KIRO_ENDPOINT, KIRO_MANAGEMENT_ENDPOINT, KIRO_MCP_ENDPOINT, KIRO_TARGET } from "../src/constants"
import { KIRO_MODEL_CATALOG, kiroModels } from "../src/catalog"
import { createKiroPlugin, KIRO_PLUGIN_ID, KiroRequestError, OAUTH_METHOD_ID } from "../src/plugin"
import KiroServerEntry from "../server"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { jsonResponse, messageOf, rejectionOf, routedFetch, scriptedFetch } from "./support/http-fixtures"
import { parseSse } from "./support/response-fixtures"
import { FAKE_LOCATION_DIRECTORY, fakeContext, httpRequestEvent, httpResponseEvent } from "./support/host-fixtures"
import { FAKE_PROFILE_ARN, keyCredential, oauthCredential, refreshBlob, setupPlugin } from "./support/pipeline-fixtures"

const OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com"

/** Kiro answers the profile lookup with no profiles; the chat call itself is the host's to dial. */
const kiroUpstream = () => routedFetch({ [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profiles: [] }) })

const chatBody = (model = "claude-opus-5.5") => ({
  model,
  max_tokens: 64,
  stream: true,
  system: [{ type: "text", text: "You are terse." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
})

describe("server.ts", () => {
  it("default-exports the plugin definition the host decodes", () => {
    expect(KiroServerEntry.id).toBe(KIRO_PLUGIN_ID)
    expect(typeof KiroServerEntry.setup).toBe("function")
  })
})

describe("registrations", () => {
  it("registers one OAuth method on kiro and key + env methods on kiro-api", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    const kiro = host.state.integrations.get("kiro")!
    const api = host.state.integrations.get("kiro-api")!

    expect(kiro.name).toBe("Kiro")
    expect(kiro.methods.map((m) => m.method.type)).toEqual(["oauth"])
    const oauth = kiro.methods[0] as IntegrationOAuthMethodRegistration
    expect(oauth.method.id).toBe(OAUTH_METHOD_ID)
    expect(oauth.method.form?.map((field) => field.key)).toEqual(["authMethod", "startUrl", "region"])
    expect(typeof oauth.refresh).toBe("function")

    expect(api.name).toBe("Kiro (API key)")
    expect(api.methods.map((m) => m.method.type)).toEqual(["key", "env"])
    const env = api.methods[1]!.method
    expect(env.type === "env" && env.names).toEqual(["KIRO_API_KEY"])
  })

  it("registers both providers on the anthropic package with the default catalog", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    for (const id of ["kiro", "kiro-api"]) {
      const provider = host.state.providers.get(id)!
      expect(provider.info.package).toBe("@opencode/ai/providers/anthropic")
      expect(provider.info.activation).toBe("auto")
      expect(String(provider.info.integrationID)).toBe(id)
      expect(provider.models.map((m) => m.id)).toEqual(KIRO_MODEL_CATALOG.map((m) => m.id))
    }
    expect(KIRO_MODEL_CATALOG.map((m) => m.id)).toEqual(["claude-fable-5.1", "claude-opus-5.5", "gpt-5.6-sol"])
    const fable = host.state.providers.get("kiro")!.models.find((m) => m.id === "claude-fable-5.1")!
    expect(fable.limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(fable.variants.map((v) => v.id)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(fable.capabilities.input).toEqual(["text", "image"])
    const sol = host.state.providers.get("kiro")!.models.find((m) => m.id === "gpt-5.6-sol")!
    expect(sol.limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(sol.variants.map((v) => v.id)).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
    // A text-only entry maps to text-only input.
    const [textOnly] = kiroModels("kiro", [{ id: "text-only", name: "Text only", context: 1, output: 1, image: false }])
    expect(textOnly!.capabilities.input).toEqual(["text"])
  })

  it("scopes the http hooks to each Kiro provider and leaves retry policy to the host", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    // A throwing http.request hook already fails the turn (the host never retries a hook defect),
    // and HTTP-level retries follow the status and retry-after the response seam sets.
    expect(host.state.hooks.retry).toEqual([])
    for (const name of ["http.request", "http.response"] as const) {
      expect(host.state.hooks[name].map((h) => h.providerID).sort()).toEqual(["kiro", "kiro-api"])
    }
  })

  it("registers the Kiro web search backend without forcing it as the default", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    expect(host.state.webSearch.map((w) => w.id)).toEqual(["kiro"])
    expect(host.state.webSearchDefault).toBeUndefined()
  })
})

describe("http.request rewrite", () => {
  it("maps the Anthropic request to a Kiro chat request with the OAuth credential", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const event = httpRequestEvent("kiro", chatBody("claude-fable-5.1"), { variant: "high" })
    await host.trigger("http.request", event)

    expect(event.request.url).toBe(KIRO_ENDPOINT)
    expect(event.request.method).toBe("POST")
    expect(event.request.headers.get("authorization")).toBe("Bearer access-1")
    expect(event.request.headers.get("x-amz-target")).toBe(KIRO_TARGET)
    expect(event.request.headers.get("content-type")).toBe("application/x-amz-json-1.0")
    expect(event.request.headers.get("tokentype")).toBeNull()

    const body = (await event.request.clone().json()) as any
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-fable-5.1")
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain("You are terse.")
    expect(body.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    })
  })

  it("only a variant the catalog declares becomes effort: the host's \"default\" and unknown variants do not", async () => {
    const additionalFields = async (modelID: string, variant?: string) => {
      const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
      const event = httpRequestEvent("kiro", chatBody(modelID), { variant })
      await host.trigger("http.request", event)
      return ((await event.request.clone().json()) as any).additionalModelRequestFields
    }
    // Live failure this guards: Kiro 400 "additionalModelRequestFields is not supported for this model".
    expect(await additionalFields("claude-opus-5.5")).toBeUndefined()
    expect(await additionalFields("claude-fable-5.1", "default")).toBeUndefined()
    expect(await additionalFields("claude-fable-5.1", "ultra")).toBeUndefined()
    // A model the catalog does not list declares nothing, so even a real level is dropped.
    expect(await additionalFields("claude-unlisted", "high")).toBeUndefined()
    expect(await additionalFields("gpt-5.6-sol", "max")).toEqual({ reasoning: { effort: "max" } })
  })

  it("uses the API key credential (stored or env) for kiro-api and omits the profile ARN", async () => {
    for (const credential of [keyCredential(), keyCredential("ksk_from_env", true)]) {
      const host = await setupPlugin({ "kiro-api": credential }, kiroUpstream())
      const event = httpRequestEvent("kiro-api", chatBody())
      await host.trigger("http.request", event)
      expect(event.request.headers.get("authorization")).toBe(`Bearer ${credential.key}`)
      expect(event.request.headers.get("tokentype")).toBe("API_KEY")
      expect(await event.request.clone().json()).not.toHaveProperty("profileArn")
    }
  })

  it("does not fire for other providers", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const event = httpRequestEvent("anthropic", chatBody())
    const original = event.request
    await host.trigger("http.request", event)
    expect(event.request).toBe(original)
  })

  it("rejects a malformed API key before anything reaches Kiro", async () => {
    const upstream = kiroUpstream()
    const host = await setupPlugin({ "kiro-api": keyCredential("not-a-kiro-key") }, upstream)
    const failure = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro-api", chatBody())))
    expect(messageOf(failure)).toContain("invalid")
    expect(upstream.calls).toHaveLength(0)
  })

  it("rejects a body that is not a JSON object with KiroRequestError before Kiro", async () => {
    for (const body of ["[]", "null", "42", "{not json"]) {
      const upstream = kiroUpstream()
      const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
      const failure = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro", body)))
      expect(failure).toBeInstanceOf(KiroRequestError)
      expect(upstream.calls).toHaveLength(0)
    }
  })

  it("fails clearly when the integration has no connection", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    const failure = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro", chatBody())))
    expect(failure).toBeInstanceOf(KiroAuthError)
    expect(messageOf(failure)).toContain("opencode auth login kiro")
  })

  it("fails clearly when the host cannot resolve the connected credential", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    Object.assign(host.ctx.integration.connection, { resolve: async () => undefined })
    const failure = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro", chatBody())))
    expect(failure).toBeInstanceOf(KiroAuthError)
    expect(messageOf(failure)).toContain("The kiro credential is unavailable")
  })

  it("rejects a device-flow credential without an access token before Kiro", async () => {
    const upstream = kiroUpstream()
    const host = await setupPlugin({ kiro: oauthCredential({ access: "" }) }, upstream)
    const failure = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro", chatBody())))
    expect(failure).toBeInstanceOf(KiroAuthError)
    expect(messageOf(failure)).toContain("expects a device-flow (OAuth) credential")
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("catalog identity and session location", () => {
  /**
   * The alias the host builds from `providers.kiro.models.fable-small: { modelID: "claude-fable-5.1",
   * limit: { context: 200000 }, variants: [{ id: "turbo" }] }`: a copy of the target with the limit
   * overridden and the listed variants added to the inherited ones (config cannot remove one).
   */
  async function withAlias() {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const models = host.state.providers.get("kiro")!.models
    const base = models.find((m) => m.id === "claude-fable-5.1")!
    models.push({
      ...structuredClone(base),
      id: "fable-small" as typeof base.id,
      limit: { ...base.limit, context: 200_000 },
      variants: [...structuredClone(base.variants), { id: "turbo" as (typeof base.variants)[number]["id"] }],
    })
    return host
  }

  it("resolves limits and effort from the host's model id, not the wire id, for a config alias", async () => {
    const host = await withAlias()
    // "turbo" exists only on the alias, so it is effort only when the lookup finds the alias.
    const declared = httpRequestEvent("kiro", chatBody("claude-fable-5.1"), { modelID: "fable-small", variant: "turbo" })
    await host.trigger("http.request", declared)
    const body = (await declared.request.clone().json()) as any
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-fable-5.1")
    expect(body.additionalModelRequestFields.output_config).toEqual({ effort: "turbo" })

    // Sent under the base model's own id, the same variant is undeclared and dropped.
    const base = httpRequestEvent("kiro", chatBody("claude-fable-5.1"), { modelID: "claude-fable-5.1", variant: "turbo" })
    await host.trigger("http.request", base)
    expect(((await base.request.clone().json()) as any).additionalModelRequestFields).toBeUndefined()

    const response = httpResponseEvent(
      declared,
      chunkedResponse(
        encodeKiroEvent("assistantResponseEvent", { content: "hi" }),
        encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 10 }),
      ),
    )
    await host.trigger("http.response", response)
    const frames = parseSse(await response.response.text())
    // 10% of the alias's 200K window, not the base model's 1M.
    expect(frames.find((f) => f.event === "message_delta")!.data.usage.input_tokens).toBe(20_000)
  })

  it("falls back to the wire id when the host's model id is not in the catalog", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const event = httpRequestEvent("kiro", chatBody("claude-fable-5.1"), { modelID: "unlisted", variant: "high" })
    await host.trigger("http.request", event)
    expect(((await event.request.clone().json()) as any).additionalModelRequestFields.output_config).toEqual({
      effort: "high",
    })
  })

  const usageAt10Percent = async (host: Awaited<ReturnType<typeof setupPlugin>>, request: ReturnType<typeof httpRequestEvent>) => {
    const response = httpResponseEvent(
      request,
      chunkedResponse(
        encodeKiroEvent("assistantResponseEvent", { content: "hi" }),
        encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 10 }),
      ),
    )
    await host.trigger("http.response", response)
    return parseSse(await response.response.text()).find((f) => f.event === "message_delta")!.data.usage.input_tokens
  }

  it("degrades to the 1M window and no effort when the host catalog is unavailable", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    Object.assign(host.ctx.model, { list: async () => Promise.reject(new Error("catalog offline")) })
    const event = httpRequestEvent("kiro", chatBody("claude-fable-5.1"), { variant: "high" })
    await host.trigger("http.request", event)

    expect(event.request.url).toBe(KIRO_ENDPOINT)
    expect(((await event.request.clone().json()) as any).additionalModelRequestFields).toBeUndefined()
    expect(await usageAt10Percent(host, event)).toBe(100_000)
  })

  it("degrades to the 1M window and no effort when neither id is in the catalog", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const event = httpRequestEvent("kiro", chatBody("claude-not-listed"), { modelID: "also-missing", variant: "high" })
    await host.trigger("http.request", event)

    expect(((await event.request.clone().json()) as any).additionalModelRequestFields).toBeUndefined()
    expect(await usageAt10Percent(host, event)).toBe(100_000)
  })

  it("gives a listed model without a usable context limit the 1M window", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const opus = host.state.providers.get("kiro")!.models.find((m) => m.id === "claude-opus-5.5")!
    opus.limit = { ...opus.limit, context: 0 }
    const event = httpRequestEvent("kiro", chatBody("claude-opus-5.5"))
    await host.trigger("http.request", event)
    expect(await usageAt10Percent(host, event)).toBe(100_000)
  })

  it("sends the plugin instance's location as the working directory, not the server's", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const event = httpRequestEvent("kiro", chatBody())
    await host.trigger("http.request", event)
    const body = (await event.request.clone().json()) as any
    const envState = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.envState
    expect(FAKE_LOCATION_DIRECTORY).not.toBe(process.cwd())
    expect(envState.currentWorkingDirectory).toBe(FAKE_LOCATION_DIRECTORY)
  })
})

describe("http.response rewrite", () => {
  it("turns the Kiro event stream into Anthropic SSE with usage from the catalog context limit", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    // A config override narrows the window, so the catalog value is distinguishable from the 1M fallback.
    const opus = host.state.providers.get("kiro")!.models.find((m) => m.id === "claude-opus-5.5")!
    opus.limit = { ...opus.limit, context: 200_000 }
    const request = httpRequestEvent("kiro", chatBody("claude-opus-5.5"))
    await host.trigger("http.request", request)

    const upstream = chunkedResponse(
      encodeKiroEvent("assistantResponseEvent", { content: "hello" }),
      encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 10 }),
    )
    const response = httpResponseEvent(request, upstream)
    await host.trigger("http.response", response)

    const frames = parseSse(await response.response.text())
    expect(response.response.status).toBe(200)
    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(frames[0]!.data.message.model).toBe("claude-opus-5.5")
    expect(frames[2]!.data.delta).toEqual({ type: "text_delta", text: "hello" })
    // 10% of the overridden 200K window, not the 1M fallback.
    expect(frames[4]!.data.usage.input_tokens).toBe(20_000)
    expect(frames[4]!.data.delta.stop_reason).toBe("end_turn")
  })

  it("maps a Kiro HTTP error into an Anthropic error response", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const request = httpRequestEvent("kiro", chatBody())
    await host.trigger("http.request", request)

    const response = httpResponseEvent(
      request,
      jsonResponse(
        { message: "Input content length exceeds threshold", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" },
        { status: 400 },
      ),
    )
    await host.trigger("http.response", response)
    expect(response.response.status).toBe(400)
    const body = (await response.response.json()) as any
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toMatch(/prompt is too long/i)
  })

  it("leaves responses it did not send alone", async () => {
    const host = await setupPlugin({ kiro: oauthCredential() }, kiroUpstream())
    const request = httpRequestEvent("kiro", chatBody())
    const passthrough = new Response("untouched", { status: 200 })
    const response = httpResponseEvent(request, passthrough)
    await host.trigger("http.response", response)
    expect(response.response).toBe(passthrough)
  })
})

describe("OAuth method", () => {
  const oauthRegistration = async (device: Record<string, unknown> = {}) => {
    const upstream = routedFetch({
      [`${OIDC_ENDPOINT}/client/register`]: () => jsonResponse({ clientId: "client-1", clientSecret: "secret-1" }),
      [`${OIDC_ENDPOINT}/device_authorization`]: () =>
        jsonResponse({
          deviceCode: "device-1",
          userCode: "WXYZ-1234",
          verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
          verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234",
          expiresIn: 600,
          interval: 1,
          ...device,
        }),
      [`${OIDC_ENDPOINT}/token`]: () =>
        jsonResponse({ accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 3600 }),
    })
    const host = await setupPlugin({}, upstream, { sleep: async () => {} })
    const method = host.state.integrations.get("kiro")!.methods[0] as IntegrationOAuthMethodRegistration
    return { method, upstream }
  }

  it("authorize runs the Builder ID device flow and resolves an opencode credential", async () => {
    const { method, upstream } = await oauthRegistration()
    const authorization = await method.authorize({ authMethod: "builder-id" })
    expect(authorization.mode).toBe("auto")
    expect(authorization.url).toBe("https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234")
    expect(authorization.instructions).toContain("WXYZ-1234")
    expect(authorization.expiresAt).toBeGreaterThan(Date.now())
    expect(upstream.calls[1]?.body).toMatchObject({ startUrl: "https://view.awsapps.com/start" })

    if (authorization.mode !== "auto") throw new Error("unreachable")
    const credential = await authorization.callback
    expect(credential.type).toBe("oauth")
    expect(String(credential.methodID)).toBe(OAUTH_METHOD_ID)
    expect(credential.access).toBe("access-2")
    expect(Number.isInteger(credential.expires)).toBe(true)
    expect(credential.expires).toBeGreaterThan(Date.now())
    const state = decodeRefreshState(credential.refresh)
    expect(state).toMatchObject({ authMethod: "builder-id", refreshToken: "refresh-2", clientId: "client-1" })
  })

  it("authorize falls back to the verification URI when the complete URI is absent", async () => {
    const { method } = await oauthRegistration({ verificationUriComplete: undefined })
    const authorization = await method.authorize({ authMethod: "builder-id" })
    expect(authorization.url).toBe("https://device.sso.us-east-1.amazonaws.com/")
    expect(authorization.instructions).toContain("WXYZ-1234")
  })

  it("authorize takes the Identity Center start URL and region from the form answer", async () => {
    const { method, upstream } = await oauthRegistration()
    await method.authorize({ authMethod: "idc", startUrl: "https://mycompany.awsapps.com/start/", region: " US-EAST-1 " })
    expect(upstream.calls[1]?.body).toMatchObject({ startUrl: "https://mycompany.awsapps.com/start" })
    expect(upstream.calls[0]?.url).toBe(`${OIDC_ENDPOINT}/client/register`)
  })

  it("authorize surfaces the normalizer message for a bad Identity Center answer", async () => {
    const { method, upstream } = await oauthRegistration()
    const failure = await rejectionOf(method.authorize({ authMethod: "idc", startUrl: "http://plain", region: "nowhere" }))
    expect(messageOf(failure)).toContain("HTTPS")
    expect(upstream.calls).toHaveLength(0)
  })

  it("authorize rejects an unknown sign-in method before contacting AWS", async () => {
    const { method, upstream } = await oauthRegistration()
    const failure = await rejectionOf(method.authorize({ authMethod: "saml" }))
    expect(failure).toBeInstanceOf(KiroAuthError)
    expect(messageOf(failure)).toContain('Unknown Kiro sign-in "saml"')
    expect(upstream.calls).toHaveLength(0)
  })

  it("refresh rotates through AWS SSO OIDC, keeps the method id, and single-flights concurrent calls", async () => {
    const { method, upstream } = await oauthRegistration()
    const stale = oauthCredential({ expires: 0 })
    const [a, b] = await Promise.all([method.refresh!(stale), method.refresh!(stale)])
    expect(a).toBe(b)
    expect(upstream.calls.filter((call) => call.url === `${OIDC_ENDPOINT}/token`)).toHaveLength(1)
    expect(String(a.methodID)).toBe(OAUTH_METHOD_ID)
    expect(a.access).toBe("access-2")
    expect(decodeRefreshState(a.refresh).refreshToken).toBe("refresh-2")

    // A later call with the rotated blob is a new flight.
    const again = await method.refresh!(a)
    expect(upstream.calls.filter((call) => call.url === `${OIDC_ENDPOINT}/token`)).toHaveLength(2)
    expect(String(again.methodID)).toBe(OAUTH_METHOD_ID)
  })

  it("refresh preserves a foreign method id and rejects an unsupported refresh blob", async () => {
    const { method } = await oauthRegistration()
    const foreign = oauthCredential({ methodID: "other-method" as Credential.OAuth["methodID"], expires: 0 })
    expect(String((await method.refresh!(foreign)).methodID)).toBe("other-method")
    const failure = await rejectionOf(method.refresh!(oauthCredential({ refresh: "opaque-refresh-token" })))
    expect(messageOf(failure)).toContain("format is unsupported")
  })

  it("concurrent refreshes share one failed flight, and the next refresh tries again", async () => {
    let tokenCalls = 0
    const upstream = routedFetch({
      [`${OIDC_ENDPOINT}/token`]: () =>
        ++tokenCalls === 1
          ? jsonResponse({ error: "invalid_grant", error_description: "refresh token expired" }, { status: 400 })
          : jsonResponse({ accessToken: "access-3", expiresIn: 3600 }),
    })
    const host = await setupPlugin({}, upstream)
    const method = host.state.integrations.get("kiro")!.methods[0] as IntegrationOAuthMethodRegistration
    const stale = oauthCredential({ expires: 0 })

    const failures = await Promise.all([rejectionOf(method.refresh!(stale)), rejectionOf(method.refresh!(stale))])
    expect(failures[0]).toBe(failures[1])
    expect(failures[0]).toBeInstanceOf(KiroAuthError)
    expect(tokenCalls).toBe(1)

    const recovered = await method.refresh!(stale)
    expect(tokenCalls).toBe(2)
    expect(recovered.access).toBe("access-3")
    // No rotated refresh token in the answer: the packed state keeps the one it had.
    expect(decodeRefreshState(recovered.refresh).refreshToken).toBe("refresh-1")
  })

  it("concurrent refreshes of different credentials do not share a flight", async () => {
    const upstream = scriptedFetch(
      (call) => {
        if (!call.url.startsWith(`${OIDC_ENDPOINT}/token`)) throw new Error(`unrouted ${call.url}`)
        const token = (call.body as { refreshToken: string }).refreshToken
        return jsonResponse({ accessToken: `access-for-${token}`, refreshToken: `${token}-next`, expiresIn: 3600 })
      },
      { onExhausted: "repeat-last" },
    )
    const host = await setupPlugin({}, upstream)
    const method = host.state.integrations.get("kiro")!.methods[0] as IntegrationOAuthMethodRegistration
    const [a, b] = await Promise.all([
      method.refresh!(oauthCredential({ refresh: refreshBlob("rt-A"), expires: 0 })),
      method.refresh!(oauthCredential({ refresh: refreshBlob("rt-B"), expires: 0 })),
    ])
    expect(upstream.calls.map((call) => (call.body as { refreshToken: string }).refreshToken).sort()).toEqual([
      "rt-A",
      "rt-B",
    ])
    expect(a.access).toBe("access-for-rt-A")
    expect(b.access).toBe("access-for-rt-B")
    expect(decodeRefreshState(a.refresh).refreshToken).toBe("rt-A-next")
    expect(decodeRefreshState(b.refresh).refreshToken).toBe("rt-B-next")
  })

  it("locations of one plugin share a refresh flight for the same stored credential", async () => {
    let tokenCalls = 0
    const upstream = routedFetch({
      [`${OIDC_ENDPOINT}/token`]: () => {
        tokenCalls += 1
        return jsonResponse({ accessToken: "access-shared", refreshToken: "refresh-shared", expiresIn: 3600 })
      },
    })
    const plugin = createKiroPlugin({ fetch: upstream.fetch })
    const methods = await Promise.all(
      ["/work/a", "/work/b"].map(async (directory) => {
        const host = fakeContext({ directory })
        await plugin.setup(host.ctx)
        return host.state.integrations.get("kiro")!.methods[0] as IntegrationOAuthMethodRegistration
      }),
    )
    const stale = oauthCredential({ expires: 0 })
    const [a, b] = await Promise.all(methods.map((method) => method.refresh!(stale)))

    expect(tokenCalls).toBe(1)
    expect(a).toBe(b)
  })

  it("labels credentials by account type", async () => {
    const { method } = await oauthRegistration()
    expect(method.label!(oauthCredential())).toBe("AWS Builder ID")
    const idc = encodeRefreshState({ ...decodeRefreshState(refreshBlob()), authMethod: "idc", startUrl: "https://acme.awsapps.com/start" })
    expect(method.label!(oauthCredential({ refresh: idc }))).toBe("IAM Identity Center (acme.awsapps.com)")
    expect(method.label!(oauthCredential({ refresh: "garbage" }))).toBeUndefined()
  })
})

describe("web search", () => {
  const mcpUpstream = (content: unknown) =>
    routedFetch({
      [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profiles: [{ arn: FAKE_PROFILE_ARN }] }),
      [KIRO_MCP_ENDPOINT]: () =>
        jsonResponse({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(content) }] } }),
    })

  it("searches through the signed-in kiro integration and shapes results for the host", async () => {
    const upstream = mcpUpstream({
      results: [
        { title: "Bun", url: "https://bun.sh", snippet: "Fast runtime", publishedDate: 1_700_000_000_000 },
        { title: "no url", snippet: "dropped" },
        { url: "https://example.com" },
      ],
    })
    const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
    const results = await host.state.webSearch[0]!.execute({ query: "bun" }, { signal: new AbortController().signal })
    expect(results).toEqual([
      { url: "https://bun.sh", title: "Bun", content: "Fast runtime", time: { published: 1_700_000_000_000 } },
      { url: "https://example.com", time: {} },
    ])
    const mcp = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))!
    expect(new Headers(mcp.init?.headers).get("authorization")).toBe("Bearer access-1")
    expect(mcp.body).toMatchObject({ method: "tools/call", profileArn: FAKE_PROFILE_ARN })
  })

  it("prefers the device-flow login when both integrations are connected", async () => {
    const upstream = mcpUpstream({ results: [] })
    const host = await setupPlugin({ kiro: oauthCredential(), "kiro-api": keyCredential() }, upstream)
    await host.state.webSearch[0]!.execute({ query: "x" }, { signal: new AbortController().signal })
    const mcp = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))!
    const headers = new Headers(mcp.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer access-1")
    expect(headers.get("tokentype")).toBeNull()
  })

  it("falls back to kiro-api when only the API key is connected", async () => {
    const upstream = routedFetch({
      [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profile: { arn: FAKE_PROFILE_ARN } }),
      [KIRO_MCP_ENDPOINT]: () =>
        jsonResponse({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] } }),
    })
    const host = await setupPlugin({ "kiro-api": keyCredential() }, upstream)
    expect(await host.state.webSearch[0]!.execute({ query: "x" }, { signal: new AbortController().signal })).toEqual([])
    const mcp = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))!
    expect(new Headers(mcp.init?.headers).get("tokentype")).toBe("API_KEY")
  })

  it("does not dispatch InvokeMCP once the search is cancelled during the profile lookup", async () => {
    const controller = new AbortController()
    let mcpCalls = 0
    const upstream = routedFetch({
      [KIRO_MANAGEMENT_ENDPOINT]: () => {
        controller.abort(new Error("search cancelled"))
        return jsonResponse({ profiles: [{ arn: `${FAKE_PROFILE_ARN}-cancel` }] })
      },
      [KIRO_MCP_ENDPOINT]: () => {
        mcpCalls += 1
        return jsonResponse({ jsonrpc: "2.0", id: "1", result: { content: [] } })
      },
    })
    const host = await setupPlugin({ kiro: oauthCredential({ access: "access-cancel" }) }, upstream)
    const failure = await rejectionOf(host.state.webSearch[0]!.execute({ query: "x" }, { signal: controller.signal }))
    expect(messageOf(failure)).toBe("search cancelled")
    expect(mcpCalls).toBe(0)
  })

  it("forwards the search's abort signal to the InvokeMCP fetch", async () => {
    const upstream = mcpUpstream({ results: [] })
    const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
    const signal = new AbortController().signal
    await host.state.webSearch[0]!.execute({ query: "x" }, { signal })
    const mcp = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))!
    expect(mcp.init?.signal).toBe(signal)
  })

  it("explains what to connect when nothing is signed in", async () => {
    const host = await setupPlugin({}, kiroUpstream())
    const failure = await rejectionOf(
      host.state.webSearch[0]!.execute({ query: "x" }, { signal: new AbortController().signal }),
    )
    expect(messageOf(failure)).toContain("opencode auth login kiro")
  })
})
