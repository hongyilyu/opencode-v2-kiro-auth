import { describe, expect, it } from "bun:test"
import { fetchApiKeyProfileArn } from "../src/apikey"
import {
  KIRO_ENDPOINT,
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_MCP_ENDPOINT,
  KIRO_ORIGIN,
  KIRO_PROFILE_ARN_PLACEHOLDER,
  WEB_SEARCH_QUERY_MAX,
} from "../src/constants"
import { KiroRequestError } from "../src/plugin"
import { getProfileArn } from "../src/profile"
import { chunkedResponse, encodeKiroEvent } from "./support/eventstream-fixtures"
import { httpRequestEvent, httpResponseEvent } from "./support/host-fixtures"
import { jsonResponse, messageOf, rejectionOf, routedFetch, scriptedFetch } from "./support/http-fixtures"
import { isolateEnv } from "./support/isolation"
import {
  FAKE_PROFILE_ARN as PROFILE_ARN,
  keyCredential,
  oauthCredential,
  setupPlugin,
} from "./support/pipeline-fixtures"

/** A signed-in `kiro` upstream: ListAvailableProfiles answers PROFILE_ARN, InvokeMCP answers `mcpText`. */
const kiroUpstream = (mcpText?: unknown) =>
  routedFetch({
    [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profiles: [{ arn: PROFILE_ARN }] }),
    [KIRO_MCP_ENDPOINT]: () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: { content: mcpText === undefined ? [] : [{ type: "text", text: JSON.stringify(mcpText) }] },
      }),
  })

const signal = () => new AbortController().signal

describe("injected Kiro client seams", () => {
  it("rejects a non-object request body with a secret-free KiroRequestError before dialing anything", async () => {
    const upstream = scriptedFetch()

    // Truncated JSON, and valid JSON whose top level is not an object.
    for (const body of ['{"secret":"ksk_must_not_leak"', "null", "[1,2]", '"text"']) {
      const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
      const event = httpRequestEvent("kiro", body)
      const original = event.request
      const failure = await rejectionOf(host.trigger("http.request", event))

      expect(failure).toBeInstanceOf(KiroRequestError)
      expect(messageOf(failure)).toBe("Invalid JSON request body: the Anthropic request must be a JSON object.")
      expect(messageOf(failure)).not.toContain("ksk_must_not_leak")
      expect(event.request).toBe(original)
    }
    expect(upstream.calls).toHaveLength(0)
  })

  it("runs the chat pipeline end to end without the plugin dialing the chat endpoint", async () => {
    const upstream = kiroUpstream()
    const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
    const request = httpRequestEvent("kiro", {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "reply offline" }],
    })
    await host.trigger("http.request", request)

    expect(request.request.url).toBe(KIRO_ENDPOINT)
    expect(request.request.headers.get("x-amz-target")).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    )
    expect(((await request.request.clone().json()) as any).profileArn).toBe(PROFILE_ARN)

    const response = httpResponseEvent(
      request,
      chunkedResponse(encodeKiroEvent("assistantResponseEvent", { content: "offline reply" })),
    )
    await host.trigger("http.response", response)
    const sse = await response.response.text()

    expect(response.response.status).toBe(200)
    expect(sse).toContain('"type":"text_delta","text":"offline reply"')
    expect(sse).toContain('"type":"message_stop"')
    // The profile lookup is the plugin's only call; the host sends the chat itself.
    expect(upstream.calls.map((call) => call.url)).toEqual([`${KIRO_MANAGEMENT_ENDPOINT}?origin=${KIRO_ORIGIN}`])
  })

  it("runs web search end to end through the kiro backend without network access", async () => {
    const upstream = kiroUpstream({
      results: [{ title: "Bun 1.3", url: "https://bun.sh/blog/bun-v1.3", snippet: "Bun 1.3 release notes" }],
    })
    const host = await setupPlugin({ kiro: oauthCredential() }, upstream)

    const results = await host.state.webSearch[0]!.execute({ query: "latest Bun release" }, { signal: signal() })
    const rpcBody = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))?.body as Record<string, any>

    expect(rpcBody?.profileArn).toBe(PROFILE_ARN)
    expect(rpcBody?.method).toBe("tools/call")
    expect(rpcBody?.params?.arguments?.query).toBe("latest Bun release")
    expect(results).toEqual([
      { url: "https://bun.sh/blog/bun-v1.3", title: "Bun 1.3", content: "Bun 1.3 release notes", time: {} },
    ])
  })

  it("truncates over-long web search queries to the backend limit", async () => {
    const upstream = kiroUpstream()
    const host = await setupPlugin({ kiro: oauthCredential() }, upstream)

    const longQuery = "q".repeat(WEB_SEARCH_QUERY_MAX + 50)
    const results = await host.state.webSearch[0]!.execute({ query: longQuery }, { signal: signal() })
    const rpcBody = upstream.calls.find((call) => call.url.startsWith(KIRO_MCP_ENDPOINT))?.body as Record<string, any>

    expect(results).toEqual([])
    expect(rpcBody?.params?.arguments?.query).toBe("q".repeat(WEB_SEARCH_QUERY_MAX))
  })
})

describe("HTTP errors through the http.response hook", () => {
  isolateEnv("KIRO_RATE_LIMIT_RETRY_SECONDS")

  const CHAT_BODY = {
    model: "claude-sonnet-4.6",
    messages: [{ role: "user", content: "trigger an upstream error" }],
  }

  /**
   * A kiro-api chat turn whose host-sent upstream answered with one fixed HTTP error. API-key chat
   * needs no profile lookup, so `fetchCalls` counts only what the plugin re-sent on its own.
   */
  async function chatAgainst(upstream: Response): Promise<{ response: Response; fetchCalls: number }> {
    const { fetch, calls } = scriptedFetch()
    const host = await setupPlugin({ "kiro-api": keyCredential() }, { fetch })
    const request = httpRequestEvent("kiro-api", CHAT_BODY)
    await host.trigger("http.request", request)
    const event = httpResponseEvent(request, upstream)
    await host.trigger("http.response", event)
    return { response: event.response, fetchCalls: calls.length }
  }

  it("forwards the upstream retry-after on a 429", async () => {
    delete process.env.KIRO_RATE_LIMIT_RETRY_SECONDS
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    )

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("17")
    expect(await response.json()).toEqual({ message: "Too many requests" })
  })

  it("lets KIRO_RATE_LIMIT_RETRY_SECONDS override the upstream retry-after on a 429", async () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "45"
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    )

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("45")
  })

  it("forwards a 503 retry-after verbatim even when KIRO_RATE_LIMIT_RETRY_SECONDS is set", async () => {
    process.env.KIRO_RATE_LIMIT_RETRY_SECONDS = "45"
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "Service unavailable" }), {
        status: 503,
        headers: { "retry-after": "9" },
      }),
    )

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("retry-after")).toBe("9")
    expect(await response.json()).toEqual({ message: "Service unavailable" })
  })

  it("redacts an API key in a passthrough error body exactly once", async () => {
    const { response, fetchCalls } = await chatAgainst(
      new Response(JSON.stringify({ message: "rejected credential ksk_leakedsecret123" }), { status: 403 }),
    )
    const text = await response.text()

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(text).toBe(JSON.stringify({ message: "rejected credential ksk_<redacted>" }))
    expect(text.split("ksk_").length - 1).toBe(1)
  })

  it("passes a non-JSON error body through verbatim with a JSON content-type", async () => {
    const { response, fetchCalls } = await chatAgainst(new Response("boom", { status: 500 }))

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("boom")
  })

  it("maps an empty error body to a generic failure message", async () => {
    const { response, fetchCalls } = await chatAgainst(new Response("", { status: 503 }))

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("Kiro request failed (503)")
  })

  it("reshapes CONTENT_LENGTH_EXCEEDS_THRESHOLD into a prompt-too-long error", async () => {
    const { response, fetchCalls } = await chatAgainst(
      new Response(
        JSON.stringify({
          __type: "ValidationException",
          message: "Input content length exceeds threshold",
          reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
        }),
        { status: 400 },
      ),
    )
    const error = (await response.json()) as any

    expect(fetchCalls).toBe(0)
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(error.type).toBe("error")
    expect(error.error.type).toBe("invalid_request_error")
    expect(error.error.message).toMatch(/prompt is too long/i)
    expect(error.error.message).not.toContain("CONTENT_LENGTH_EXCEEDS_THRESHOLD")
  })
})

describe("credential-tier client seams", () => {
  it("falls through a GetProfile network error to the second region", async () => {
    const urls: string[] = []
    const fetcher = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input))
      if (urls.length === 1) throw new TypeError("offline region")
      return new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } }))
    }) as unknown as typeof globalThis.fetch

    expect(await fetchApiKeyProfileArn("ksk_networkfallback", { fetch: fetcher })).toBe(PROFILE_ARN)
    expect(urls).toEqual([
      "https://management.us-east-1.kiro.dev/",
      "https://management.eu-central-1.kiro.dev/",
    ])
  })

  it("redacts the key from GetProfile transport errors it reports", async () => {
    const fetcher = (async () => {
      throw new TypeError("Header 'Authorization' has invalid value: 'Bearer ksk_diagnosticskey'")
    }) as unknown as typeof globalThis.fetch

    const message = messageOf(await rejectionOf(fetchApiKeyProfileArn("ksk_diagnosticskey", { fetch: fetcher })))
    expect(message).toContain("has invalid value")
    expect(message).not.toContain("ksk_diagnosticskey")
    expect(message).toContain("<redacted>")
  })

  it("falls through an ok GetProfile response without a usable ARN", async () => {
    const urls: string[] = []
    const fetcher = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input))
      if (urls.length === 1) return new Response(JSON.stringify({ profile: {} }))
      return new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } }))
    }) as unknown as typeof globalThis.fetch

    expect(await fetchApiKeyProfileArn("ksk_unusablefirstregion", { fetch: fetcher })).toBe(PROFILE_ARN)
    expect(urls).toEqual([
      "https://management.us-east-1.kiro.dev/",
      "https://management.eu-central-1.kiro.dev/",
    ])
  })

  it("reports an error after both GetProfile regions reject", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 403 })
    }) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_allregionsfail", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(calls).toBe(2)
    expect(message).toContain("could not use the configured credential")
    expect(message).toContain("management.us-east-1.kiro.dev: HTTP 403")
    expect(message).toContain("management.eu-central-1.kiro.dev: HTTP 403")
  })

  it("names each region's distinct failure in the error", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return calls === 1 ? new Response("{}", { status: 503 }) : new Response("not json")
    }) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_diagnosticskey", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain("management.us-east-1.kiro.dev: HTTP 503")
    expect(message).toContain("management.eu-central-1.kiro.dev: non-JSON response")
    // The diagnostics never include the credential.
    expect(message).not.toContain("ksk_diagnosticskey")
  })

  it("reports an ok response that lacks a profile ARN", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ profile: {} }))) as unknown as typeof globalThis.fetch

    const message = await fetchApiKeyProfileArn("ksk_noarnanywhere", { fetch: fetcher }).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain("management.us-east-1.kiro.dev: response has no profile ARN")
    expect(message).toContain("management.eu-central-1.kiro.dev: response has no profile ARN")
  })

  it("maps ListAvailableProfiles failure to the placeholder", async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response("{}", { status: 503 })
    }) as unknown as typeof globalThis.fetch

    expect(await getProfileArn("list-profile-failure", { fetch: fetcher })).toBe(
      KIRO_PROFILE_ARN_PLACEHOLDER,
    )
    expect(calls).toBe(1)
  })
})
