import { describe, expect, it } from "bun:test"
import { KiroApiKeyError, normalizeApiKey } from "../src/apikey"
import { KiroAuthError } from "../src/auth"
import { createApiKeySession, createSession } from "../src/session"
import { httpRequestEvent } from "./support/host-fixtures"
import { messageOf, rejectionOf, routedFetch, thrownMessage } from "./support/http-fixtures"
import { keyCredential, oauthCredential, setupPlugin, TOOL_CHAT_BODY } from "./support/pipeline-fixtures"

const API_KEY = "ksk_offlinetestkey"

describe("api key validation", () => {
  it("api: rejects an empty key", () => {
    const empty = () => normalizeApiKey("   ")
    expect(empty).toThrow(KiroApiKeyError)
    expect(thrownMessage(empty)).toContain("empty")
  })

  it("api: rejects malformed key without format guidance", () => {
    const badPrefix = thrownMessage(() => normalizeApiKey("sk-not-a-kiro-key"))
    expect(badPrefix).toContain("invalid")
    expect(badPrefix).not.toContain("ksk_")
  })

  it("api: rejects a key the redactor could not fully mask, without echoing it", () => {
    for (const key of ["ksk_SECRETPART1\nSECRETPART2", "ksk_SECRET\rTAIL", "ksk_SECRET\u200bTAIL", "ksk_SE CRET"]) {
      const message = thrownMessage(() => normalizeApiKey(key))
      expect(message).toBe("Kiro credential is invalid.")
    }
  })

  it("api: trims a valid key", () => {
    expect(normalizeApiKey(`  ${API_KEY}  `)).toBe(API_KEY)
  })
})

describe("api key session", () => {
  it("api: sends bearer + tokentype header", async () => {
    const apiHeaders = await createApiKeySession(API_KEY).authHeaders()
    expect(apiHeaders.authorization).toBe(`Bearer ${API_KEY}`)
    expect(apiHeaders.tokentype).toBe("API_KEY")
  })

  it("api: omits profileArn in chat body", async () => {
    expect(await createApiKeySession(API_KEY).chatProfileArn()).toBeUndefined()
  })

  it("api: validates the key when the session is created", () => {
    const unusable = () => createSession({ mode: "api", key: "not-a-kiro-key" })
    expect(unusable).toThrow(KiroApiKeyError)
    expect(thrownMessage(unusable)).not.toContain("ksk_")
    expect(thrownMessage(unusable)).not.toContain("KIRO_API_KEY")
    expect(thrownMessage(unusable)).not.toContain("not-a-kiro-key")
  })
})

describe("session mode splitting", () => {
  it("split: the spec mode picks the session kind", async () => {
    const api = await createSession({ mode: "api", key: ` ${API_KEY} ` }).authHeaders()
    expect(api).toEqual({ authorization: `Bearer ${API_KEY}`, tokentype: "API_KEY" })
    const oauth = await createSession({ mode: "oauth", accessToken: "access-1" }).authHeaders()
    expect(oauth).toEqual({ authorization: "Bearer access-1" })
  })

  it("split: the api spec has no accessToken slot, the oauth spec has no key slot", () => {
    // Compile-time contract: the closures are never invoked; `bun run typecheck` fails if an
    // expected error disappears (neither session kind may be handed the other's credential).
    const apiWithToken = () =>
      // @ts-expect-error the api spec has no accessToken slot
      createSession({ mode: "api", key: API_KEY, accessToken: "access-1" })
    const oauthWithKey = () =>
      // @ts-expect-error the oauth spec has no key slot
      createSession({ mode: "oauth", accessToken: "access-1", key: API_KEY })
    expect(typeof apiWithToken).toBe("function")
    expect(typeof oauthWithKey).toBe("function")
  })

  it("split: api provider rejects an oauth credential", async () => {
    const upstream = routedFetch({})
    const host = await setupPlugin({ "kiro-api": oauthCredential() }, upstream)
    const apiModeRejects = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro-api", TOOL_CHAT_BODY)))
    expect(apiModeRejects).toBeInstanceOf(KiroAuthError)
    expect(messageOf(apiModeRejects)).toContain("API key")
    expect(messageOf(apiModeRejects)).toContain("opencode auth login kiro-api")
    expect(upstream.calls).toHaveLength(0)
  })

  it("split: oauth provider rejects an api credential", async () => {
    const upstream = routedFetch({})
    const host = await setupPlugin({ kiro: keyCredential(API_KEY) }, upstream)
    const oauthModeRejectsApi = await rejectionOf(host.trigger("http.request", httpRequestEvent("kiro", TOOL_CHAT_BODY)))
    expect(oauthModeRejectsApi).toBeInstanceOf(KiroAuthError)
    expect(messageOf(oauthModeRejectsApi)).toContain("OAuth")
    expect(messageOf(oauthModeRejectsApi)).toContain("opencode auth login kiro`")
    expect(upstream.calls).toHaveLength(0)
  })
})
