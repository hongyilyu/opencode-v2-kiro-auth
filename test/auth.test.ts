import { beforeAll, describe, expect, it } from "bun:test"
import {
  beginDeviceAuthorization,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroAuthError,
  refreshOAuthCredential,
  type OAuthCredential,
} from "../src/auth"
import { createSession } from "../src/session"
import { jsonResponse, messageOf, rejectionOf, scriptedFetch, thrownMessage } from "./support/http-fixtures"

describe("device authorization flow", () => {
  // Scripted OIDC exchange: register client -> start device flow -> pending -> slow_down -> token.
  const deviceFlow = scriptedFetch(
    jsonResponse({ clientId: "client-1", clientSecret: "secret-1", clientSecretExpiresAt: 9_999_999_999 }),
    jsonResponse({
      deviceCode: "device-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 2,
    }),
    jsonResponse({ error: "authorization_pending" }, { status: 400 }),
    jsonResponse({ error: "slow_down" }, { status: 400 }),
    jsonResponse({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
  )
  const waits: number[] = []
  let credential: OAuthCredential

  beforeAll(async () => {
    const pending = await beginDeviceAuthorization(
      { authMethod: "builder-id" },
      { fetch: deviceFlow.fetch, now: () => 1_000 },
    )
    credential = await completeDeviceAuthorization(pending, {
      fetch: deviceFlow.fetch,
      now: () => 1_000,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })
  })

  it("registers independent OAuth client", () => {
    expect(deviceFlow.calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/client/register")
    expect(deviceFlow.calls[0]?.body).toHaveProperty("clientName", "opencode-v2-kiro-auth")
    expect(deviceFlow.calls[0]?.body).toHaveProperty("clientType", "public")
  })

  it("starts Builder ID device flow", () => {
    expect(deviceFlow.calls[1]?.url).toBe("https://oidc.us-east-1.amazonaws.com/device_authorization")
    expect(deviceFlow.calls[1]?.body).toHaveProperty("startUrl", "https://view.awsapps.com/start")
  })

  it("polls pending and slow-down responses", () => {
    expect(waits.join(",")).toBe("2000,2000,7000")
    expect(deviceFlow.calls).toHaveLength(5)
  })

  it("stores self-contained refresh state", () => {
    const state = decodeRefreshState(credential.refresh)
    expect(credential.access).toBe("access-1")
    expect(state.refreshToken).toBe("refresh-1")
    expect(state.clientId).toBe("client-1")
    expect(state.clientSecret).toBe("secret-1")
    expect(state.authMethod).toBe("builder-id")
  })

  describe("credential refresh", () => {
    /**
     * An OIDC token endpoint that answers `access-<n+1>` on its n-th call and records each
     * refreshToken it is asked to exchange, so a test can prove which token was sent.
     */
    function oidcRefresh(options: { rotate?: boolean; failures?: number } = {}) {
      const receivedRefreshTokens: unknown[] = []
      const oidc = scriptedFetch(
        (call) => {
          receivedRefreshTokens.push((call.body as { refreshToken?: unknown }).refreshToken)
          const n = receivedRefreshTokens.length
          if (n <= (options.failures ?? 0)) return jsonResponse({ error: "invalid_grant" }, { status: 400 })
          return jsonResponse({
            accessToken: `access-${n + 1}`,
            refreshToken: options.rotate ? `refresh-${n + 1}` : undefined,
            expiresIn: 3600,
          })
        },
        { onExhausted: "repeat-last" },
      )
      return { ...oidc, dependencies: { fetch: oidc.fetch, now: () => 2_000 }, receivedRefreshTokens }
    }

    it("keeps the refresh state when OIDC does not rotate the refresh token", async () => {
      const oidc = oidcRefresh()
      const next = await refreshOAuthCredential(credential, oidc.dependencies)
      expect(oidc.calls.map((call) => call.url)).toEqual(["https://oidc.us-east-1.amazonaws.com/token"])
      expect(oidc.receivedRefreshTokens).toEqual(["refresh-1"])
      expect(next.access).toBe("access-2")
      expect(next.expires).toBe(2_000 + 3_600_000)
      expect(decodeRefreshState(next.refresh)).toEqual(decodeRefreshState(credential.refresh))
    })

    it("exchanges the rotated refresh token on the next refresh, never the superseded one", async () => {
      const oidc = oidcRefresh({ rotate: true })
      const first = await refreshOAuthCredential(credential, oidc.dependencies)
      const second = await refreshOAuthCredential(first, oidc.dependencies)
      expect(oidc.receivedRefreshTokens).toEqual(["refresh-1", "refresh-2"])
      expect(second.access).toBe("access-3")
      expect(decodeRefreshState(second.refresh).refreshToken).toBe("refresh-3")
    })

    it("a failed refresh surfaces the OIDC error and leaves the credential refreshable", async () => {
      const oidc = oidcRefresh({ rotate: true, failures: 1 })
      const error = await rejectionOf(refreshOAuthCredential(credential, oidc.dependencies))
      expect(error).toBeInstanceOf(KiroAuthError)
      expect(messageOf(error)).toContain("invalid_grant")

      expect((await refreshOAuthCredential(credential, oidc.dependencies)).access).toBe("access-3")
      expect(oidc.receivedRefreshTokens).toEqual(["refresh-1", "refresh-1"])
    })
  })

  describe("oauth session", () => {
    it("oauth: no tokentype header, resolves profileArn for chat and MCP", async () => {
      const arn = "arn:aws:codewhisperer:us-east-1:111122223333:profile/OAUTHTEST"
      const profile = scriptedFetch(() => jsonResponse({ profiles: [{ arn }] }), { onExhausted: "repeat-last" })
      const oauthSession = createSession({ mode: "oauth", accessToken: credential.access }, { fetch: profile.fetch })
      const oauthHeaders = await oauthSession.authHeaders()
      expect(oauthHeaders.tokentype).toBeUndefined()
      expect(oauthHeaders.authorization).toBe("Bearer access-1")
      expect(await oauthSession.chatProfileArn()).toBe(arn)
      expect(await oauthSession.mcpProfileArn()).toBe(arn)
    })
  })
})

describe("credential migration", () => {
  it("rejects a legacy kiro-cli credential as unsupported without calling OIDC", async () => {
    const { fetch, calls } = scriptedFetch()
    const legacy: OAuthCredential = { type: "oauth", access: "", refresh: "kiro-cli-managed", expires: 0 }
    const message = messageOf(await rejectionOf(refreshOAuthCredential(legacy, { fetch })))
    expect(message).toBe(thrownMessage(() => decodeRefreshState("some-other-scheme:abc"))!)
    expect(message).toContain("opencode auth login kiro`")
    expect(calls).toHaveLength(0)
  })
})
