import type { Credential } from "@opencode/plugin"
import { encodeRefreshState } from "../../src/auth"
import { KIRO_ENDPOINT, KIRO_MANAGEMENT_ENDPOINT } from "../../src/constants"
import { createKiroPlugin, OAUTH_METHOD_ID, type KiroPluginDependencies } from "../../src/plugin"
import type { KiroSession } from "../../src/session"
import { chunkedResponse } from "./eventstream-fixtures"
import { fakeContext, httpRequestEvent, httpResponseEvent, type FakeCredentials } from "./host-fixtures"
import { jsonResponse, routedFetch, type RoutedFetch } from "./http-fixtures"

export const FAKE_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/TEST"

/** A KiroSession that answers with fixed values; override the token, the profile ARN, or any method. */
export function fakeSession(
  overrides: Partial<KiroSession> & { token?: string; profileArn?: string } = {},
): KiroSession {
  const { token = "test-token", profileArn = FAKE_PROFILE_ARN, ...methods } = overrides
  return {
    async authHeaders() {
      return { authorization: `Bearer ${token}` }
    },
    async chatProfileArn() {
      return profileArn
    },
    async mcpProfileArn() {
      return profileArn
    },
    ...methods,
  }
}

/** A packed Builder ID refresh state, as a device-flow login stores it. */
export const refreshBlob = (refreshToken = "refresh-1") =>
  encodeRefreshState({
    version: 1,
    refreshToken,
    clientId: "client-1",
    clientSecret: "secret-1",
    region: "us-east-1",
    startUrl: "https://view.awsapps.com/start",
    authMethod: "builder-id",
  })

/** A fresh device-flow credential as the host stores and resolves it. */
export const oauthCredential = (overrides: Partial<Credential.OAuth> = {}): Credential.OAuth => ({
  type: "oauth",
  methodID: OAUTH_METHOD_ID as Credential.OAuth["methodID"],
  access: "access-1",
  refresh: refreshBlob(),
  expires: Date.now() + 60 * 60 * 1000,
  ...overrides,
})

/** An API key credential; `env` marks it as resolved from KIRO_API_KEY rather than stored. */
export const keyCredential = (key = "ksk_test_key", env = false): Credential.Key => ({
  type: "key",
  key,
  ...(env ? { metadata: { env: true } } : {}),
})

/** The plugin set up against a fake host holding `credentials`, over an injected upstream. */
export async function setupPlugin(
  credentials: FakeCredentials,
  upstream: RoutedFetch | { fetch: typeof globalThis.fetch },
  dependencies: Omit<KiroPluginDependencies, "fetch"> = {},
) {
  const host = fakeContext({ credentials })
  await createKiroPlugin({ ...dependencies, fetch: upstream.fetch }).setup(host.ctx)
  return host
}

/** The request the pipeline tests send: one user prompt and a single `bash` tool definition. */
export const TOOL_CHAT_BODY = {
  model: "claude-fable-5.1",
  messages: [{ role: "user", content: "run a command" }],
  tools: [
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ],
}

/**
 * Drive one chat request through the real plugin pipeline — the http.request rewrite, then the
 * http.response rewrite over an upstream that answers with the given eventstream chunks — against
 * a fake host with a signed-in `kiro` integration. The request declares a single `bash` tool so
 * tool-call frames land on a real tool definition. Returns the Anthropic response the host sees.
 */
export async function fullPipeline(...chunks: Uint8Array[]): Promise<Response> {
  const upstream = routedFetch({
    [KIRO_MANAGEMENT_ENDPOINT]: () => jsonResponse({ profiles: [{ arn: FAKE_PROFILE_ARN }] }),
  })
  const host = await setupPlugin({ kiro: oauthCredential() }, upstream)
  const request = httpRequestEvent("kiro", TOOL_CHAT_BODY)
  await host.trigger("http.request", request)
  if (request.request.url !== KIRO_ENDPOINT) throw new Error(`unexpected chat URL ${request.request.url}`)
  const response = httpResponseEvent(request, chunkedResponse(...chunks))
  await host.trigger("http.response", response)
  return response.response
}
