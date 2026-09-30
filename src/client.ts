import { randomUUID } from "node:crypto"
import {
  KIRO_CONTENT_TYPE,
  KIRO_ENDPOINT,
  KIRO_GET_PROFILE_TARGET,
  KIRO_INVOKE_MCP_TARGET,
  KIRO_LIST_PROFILES_TARGET,
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_MCP_ENDPOINT,
  KIRO_MGMT_USER_AGENT,
  KIRO_ORIGIN,
  KIRO_TARGET,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { kiroDebug, type KiroDebugContext } from "./debug"
import type { KiroRequestPayload } from "./request"
import type { KiroSession } from "./session"

/** Injectable transport for offline tests; defaults to globalThis.fetch. */
export type KiroClientDependencies = {
  fetch?: typeof globalThis.fetch
}

/** UA pair for the streaming service (chat, InvokeMCP). */
const STREAMING_UA_HEADERS = {
  "user-agent": KIRO_USER_AGENT,
  "x-amz-user-agent": KIRO_X_AMZ_USER_AGENT,
}

/** Management-service operations send the management UA for both UA headers. */
const MGMT_UA_HEADERS = {
  "user-agent": KIRO_MGMT_USER_AGENT,
  "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
}

/** JSON-RPC 2.0 request body for Kiro's built-in MCP server (InvokeMCP). */
export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: string
  method: string
  params?: unknown
}

/** The chat body actually sent: the typed payload plus the profile ARN when the session has one. */
type ChatBody = KiroRequestPayload & { profileArn?: string }
/** The InvokeMCP body: JSON-RPC plus the profile ARN, which both auth modes resolve. */
type McpBody = JsonRpcRequest & { profileArn: string }

type WireRequest = {
  url: string
  target: string
  /** Credential headers; spread first (the rendered order is pinned by the wire captures). */
  auth: Record<string, string>
  /** Operation-specific tail: UA pair, optout, SDK id headers. */
  headers: Record<string, string>
  body: ChatBody | McpBody | Record<string, never>
  /** Caller's abort signal, forwarded to fetch so a cancelled call stops upstream too. */
  signal?: AbortSignal
}

/** A fully rendered awsJson1.0 POST: the exact URL, header set, and body bytes Kiro receives. */
export type KiroHttpRequest = {
  url: string
  method: "POST"
  headers: Record<string, string>
  body: string
}

/**
 * Render a wire request. The rendered header order (auth, framing, then the tail) is what the wire
 * captures pin; the transport may still reorder headers on the socket (Bun does).
 */
function renderKiroRequest(request: WireRequest): KiroHttpRequest {
  return {
    url: request.url,
    method: "POST",
    headers: {
      ...request.auth,
      "content-type": KIRO_CONTENT_TYPE,
      "x-amz-target": request.target,
      ...request.headers,
    },
    body: JSON.stringify(request.body),
  }
}

/**
 * The shared wire core for the calls the plugin sends itself (InvokeMCP and the management
 * operations): one rendered POST, no policy. Every quirk lives with its operation.
 */
async function postKiro(request: WireRequest, dependencies: KiroClientDependencies = {}): Promise<Response> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const { url, ...init } = renderKiroRequest(request)
  return fetcher(url, { ...init, signal: request.signal })
}

/**
 * Chat (GenerateAssistantResponse), rendered for the host to send: opencode's http.request hook
 * owns the chat transport, so this builds the request and never dials. Streaming UA pair, optout
 * header, the debug trace id as amz-sdk-invocation-id (max=3), and the profile ARN in the body
 * only — and only when the session resolves one (OAuth); API-key sessions omit the field entirely.
 */
export async function buildChatRequest(
  payload: KiroRequestPayload,
  session: KiroSession,
  options: { debug: KiroDebugContext },
): Promise<KiroHttpRequest> {
  const [auth, profileArn] = await Promise.all([session.authHeaders(), session.chatProfileArn()])
  kiroDebug(options.debug, "profile.resolved", {
    hasProfile: Boolean(profileArn),
    omittedInBody: profileArn === undefined,
  })
  return renderKiroRequest({
    url: KIRO_ENDPOINT,
    target: KIRO_TARGET,
    auth,
    headers: {
      ...STREAMING_UA_HEADERS,
      "x-amzn-codewhisperer-optout": "false",
      "amz-sdk-invocation-id": options.debug.id,
      "amz-sdk-request": "attempt=1; max=3",
    },
    body: profileArn ? ({ profileArn, ...payload } satisfies ChatBody) : payload,
  })
}

/**
 * InvokeMCP. Streaming UA pair, optout, a fresh SDK invocation id per call (max=1),
 * and the profile ARN in BOTH the JSON-RPC body and the x-amzn-kiro-profile-arn
 * header — both auth modes resolve one. A caller that aborts while the (shared, memoized)
 * profile lookup is in flight never dispatches the call.
 */
export async function invokeMcpRequest(
  rpcBody: JsonRpcRequest,
  session: KiroSession,
  dependencies: KiroClientDependencies = {},
  signal?: AbortSignal,
): Promise<Response> {
  const [auth, profileArn] = await Promise.all([session.authHeaders(), session.mcpProfileArn()])
  signal?.throwIfAborted()
  return postKiro(
    {
      url: KIRO_MCP_ENDPOINT,
      target: KIRO_INVOKE_MCP_TARGET,
      auth: { ...auth, "x-amzn-kiro-profile-arn": profileArn },
      headers: {
        ...STREAMING_UA_HEADERS,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
      },
      body: { profileArn, ...rpcBody },
      signal,
    },
    dependencies,
  )
}

/**
 * ListAvailableProfiles. Management UA for both UA headers, optout, no SDK id
 * headers, and the literal KIRO_CLI origin query.
 */
export function listAvailableProfiles(
  accessToken: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return postKiro(
    {
      url: `${KIRO_MANAGEMENT_ENDPOINT}?origin=${KIRO_ORIGIN}`,
      target: KIRO_LIST_PROFILES_TARGET,
      auth: { authorization: `Bearer ${accessToken}` },
      headers: { ...MGMT_UA_HEADERS, "x-amzn-codewhisperer-optout": "false" },
      body: {},
    },
    dependencies,
  )
}

/**
 * GetProfile against one management-region endpoint. Management UA twice, no SDK id
 * headers, and deliberately NO optout header (existing drift, preserved). Region
 * sequencing belongs to the caller (apikey.ts): whether to try the next region
 * depends on the response body, which the transport does not interpret.
 */
export function getProfile(
  apiKey: string,
  endpoint: string,
  dependencies: KiroClientDependencies = {},
): Promise<Response> {
  return postKiro(
    {
      url: endpoint,
      target: KIRO_GET_PROFILE_TARGET,
      auth: { authorization: `Bearer ${apiKey}`, tokentype: "API_KEY" },
      headers: MGMT_UA_HEADERS,
      body: {},
    },
    dependencies,
  )
}
