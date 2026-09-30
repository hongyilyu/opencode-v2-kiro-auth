import type { Credential, Plugin, Provider, WebSearch } from "@opencode/plugin"
import type {
  IntegrationEditor,
  IntegrationOAuthAuthorization,
  IntegrationOAuthMethodRegistration,
} from "@opencode/plugin/promise/integration"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session"
import type { WebSearchEditor } from "@opencode/plugin/promise/websearch"
import {
  beginDeviceAuthorization,
  type AuthDependencies,
  completeDeviceAuthorization,
  decodeRefreshState,
  KiroAuthError,
  normalizeRegion,
  normalizeStartUrl,
  refreshOAuthCredential,
  type DeviceLogin,
  type OAuthCredential,
} from "./auth"
import { kiroModels } from "./catalog"
import { buildChatRequest, type KiroClientDependencies } from "./client"
import { API_PROVIDER_ID, DEFAULT_MODEL, PROVIDER_ID } from "./constants"
import { createKiroDebugContext, kiroDebug, type KiroDebugContext } from "./debug"
import { webSearch } from "./mcp"
import { toKiroPayload } from "./request"
import { kiroResponseToAnthropic } from "./response"
import { createSession, type KiroSession } from "./session"

/** Stable plugin id: opencode scopes plugin storage and diagnostics by it. */
export const KIRO_PLUGIN_ID = "hongyilyu.kiro-auth"

/**
 * The one OAuth method id. opencode 2.x imports opencode 1.x `auth.json` OAuth entries under the
 * method id "oauth"; registering ours under the same id keeps those imported credentials
 * refreshable, so an in-place upgrade needs no second login. Builder ID and Identity Center are
 * answers on the login form; the packed refresh state records which one a credential belongs to.
 */
export const OAUTH_METHOD_ID = "oauth"

/** The provider package whose protocol the request hook rewrites. Statically bundled by the host. */
const ANTHROPIC_PACKAGE = "@opencode/ai/providers/anthropic"
/** Placeholder endpoint: the http.request hook replaces the whole request, so it is never dialed. */
const PLACEHOLDER_BASE_URL = "https://kiro.local/v1"
const DEFAULT_CONTEXT_LIMIT = 1_000_000
const API_KEY_ENV_VAR = "KIRO_API_KEY"
const REGION_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)+-\\d+$"
/**
 * Mirrors normalizeStartUrl's https requirement. The host validates form patterns itself and
 * reports them cleanly; an error thrown from `authorize` surfaces only as an HTTP 500 in the v2
 * Promise plugin API (it wraps plugin promises with Effect.promise, so rejections are defects).
 */
const START_URL_PATTERN = "^https://\\S+$"

type Context = Plugin.Context

/** Injectable transport and clock for offline tests; production uses globalThis.fetch and Date.now. */
export type KiroPluginDependencies = KiroClientDependencies & AuthDependencies

/** In-flight OAuth refreshes keyed by the stored refresh blob they rotate. */
type RefreshFlights = Map<string, Promise<Credential.OAuth>>

/** Per-request state carried from the request hook to the response hook, keyed by the sent Request. */
type PendingChat = {
  debug: KiroDebugContext
  model: string
  contextLimit: number
}

/** A request whose Anthropic body cannot be mapped; malformed input never reaches Kiro. */
export class KiroRequestError extends Error {}

/**
 * The opencode host adapter. One plugin registers both providers (`kiro` for the device-flow
 * logins, `kiro-api` for API keys), their integrations, the default model catalog, the Anthropic
 * request/response rewrite, and the Kiro web search backend. Everything Kiro-specific (request
 * mapping, wire rendering, event stream to SSE) lives in the host-agnostic core; this file owns
 * only the host seams.
 */
export function createKiroPlugin(dependencies: KiroPluginDependencies = {}): Plugin.Plugin {
  // Shared by every setup: the host runs setup once per location, but all locations in the process
  // read and write the same stored credential, so they must join one rotation.
  const refreshing: RefreshFlights = new Map()
  return {
    id: KIRO_PLUGIN_ID,
    async setup(ctx) {
      const pending = new WeakMap<Request, PendingChat>()

      await ctx.integration.transform((editor) => registerIntegrations(editor, dependencies, refreshing))
      await ctx.provider.transform(registerProviders)
      await ctx.websearch.transform((editor) => registerWebSearch(editor, ctx, dependencies))

      // A hook that throws fails the turn outright: the Promise adapter turns the rejection into a
      // defect, and the host's retry policy only ever sees typed provider errors. So sign-in,
      // key, and request-shape errors thrown here are never retried, and need no retry hook.
      for (const providerID of [PROVIDER_ID, API_PROVIDER_ID]) {
        await ctx.session.hook("http.request", (event) => rewriteRequest(event, ctx, pending, dependencies), {
          providerID,
        })
        await ctx.session.hook("http.response", (event) => rewriteResponse(event, pending), { providerID })
      }
    },
  }
}

export const KiroPlugin = createKiroPlugin()

/* ------------------------------- integrations -------------------------------- */

function registerIntegrations(
  editor: IntegrationEditor,
  dependencies: KiroPluginDependencies,
  refreshing: RefreshFlights,
): void {
  editor.method.update(oauthMethod(dependencies, refreshing))
  editor.update(PROVIDER_ID, (integration) => {
    integration.name = "Kiro"
  })

  editor.method.update({ integrationID: API_PROVIDER_ID, method: { type: "key", label: "Kiro API key" } })
  editor.method.update({ integrationID: API_PROVIDER_ID, method: { type: "env", names: [API_KEY_ENV_VAR] } })
  editor.update(API_PROVIDER_ID, (integration) => {
    integration.name = "Kiro (API key)"
  })
}

/** The device-flow login as one opencode OAuth method; the account type is a form answer. */
export function oauthMethod(
  dependencies: KiroPluginDependencies,
  refreshing: RefreshFlights = new Map(),
): IntegrationOAuthMethodRegistration {
  return {
    integrationID: PROVIDER_ID,
    method: {
      id: OAUTH_METHOD_ID,
      type: "oauth",
      label: "AWS Builder ID or IAM Identity Center (device flow)",
      form: [
        {
          key: "authMethod",
          type: "string",
          title: "AWS sign-in",
          required: true,
          default: "builder-id",
          options: [
            { value: "builder-id", label: "AWS Builder ID", description: "Personal Kiro account" },
            { value: "idc", label: "IAM Identity Center", description: "Organization SSO: start URL and region" },
          ],
        },
        {
          key: "startUrl",
          type: "string",
          title: "IAM Identity Center start URL",
          placeholder: "https://mycompany.awsapps.com/start",
          format: "uri",
          pattern: START_URL_PATTERN,
          required: true,
          when: [{ key: "authMethod", op: "eq", value: "idc" }],
        },
        {
          key: "region",
          type: "string",
          title: "IAM Identity Center region",
          placeholder: "us-east-1",
          pattern: REGION_PATTERN,
          required: true,
          when: [{ key: "authMethod", op: "eq", value: "idc" }],
        },
      ],
    },
    authorize: async (answer): Promise<IntegrationOAuthAuthorization> => {
      const pending = await beginDeviceAuthorization(deviceLogin(answer), dependencies)
      const expiresInMinutes = Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 60_000))
      return {
        url: pending.verificationUriComplete ?? pending.verificationUri,
        instructions: `Enter code ${pending.userCode} and approve access. The code expires in ${expiresInMinutes} minutes.`,
        expiresAt: pending.expiresAt,
        mode: "auto",
        callback: completeDeviceAuthorization(pending, dependencies).then((credential) =>
          hostCredential(credential, OAUTH_METHOD_ID),
        ),
      }
    },
    // Single-flight per stored refresh blob, across every location in this process: the host has no
    // lock around refresh, and AWS SSO OIDC may rotate refresh tokens, so concurrent requests must
    // share one rotation. A separate process (`--standalone`) has its own flights.
    refresh: (credential) => {
      const inflight = refreshing.get(credential.refresh)
      if (inflight) return inflight
      const next = refreshOAuthCredential(pluginCredential(credential), dependencies)
        .then((refreshed) => hostCredential(refreshed, credential.methodID))
        .finally(() => refreshing.delete(credential.refresh))
      refreshing.set(credential.refresh, next)
      return next
    },
    label: (credential) => {
      try {
        const state = decodeRefreshState(credential.refresh)
        return state.authMethod === "idc" ? `IAM Identity Center (${new URL(state.startUrl).host})` : "AWS Builder ID"
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Form answers -> the device login. The normalizers' KiroAuthError is a backstop only: a rejected
 * `authorize` reaches the CLI as a bare HTTP 500, so the form's `pattern`/`format` carry validation.
 */
function deviceLogin(answer: Record<string, unknown>): DeviceLogin {
  const method = answer.authMethod ?? "builder-id"
  if (method === "builder-id") return { authMethod: "builder-id" }
  if (method !== "idc") throw new KiroAuthError(`Unknown Kiro sign-in "${String(method)}".`)
  return {
    authMethod: "idc",
    startUrl: normalizeStartUrl(typeof answer.startUrl === "string" ? answer.startUrl : ""),
    region: normalizeRegion(typeof answer.region === "string" ? answer.region : ""),
  }
}

function hostCredential(credential: OAuthCredential, methodID: string): Credential.OAuth {
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    access: credential.access,
    refresh: credential.refresh,
    expires: Math.max(0, Math.floor(credential.expires)),
  }
}

function pluginCredential(credential: Credential.OAuth): OAuthCredential {
  return { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires }
}

/* --------------------------------- providers --------------------------------- */

function registerProviders(editor: ProviderEditor): void {
  editor.add({ info: providerInfo(PROVIDER_ID, "Kiro"), models: kiroModels(PROVIDER_ID) })
  editor.add({ info: providerInfo(API_PROVIDER_ID, "Kiro (API key)"), models: kiroModels(API_PROVIDER_ID) })
}

function providerInfo(id: string, name: string): Provider.Info {
  return {
    id: id as Provider.ID,
    name,
    activation: "auto",
    package: ANTHROPIC_PACKAGE,
    settings: { baseURL: PLACEHOLDER_BASE_URL },
    integrationID: id as NonNullable<Provider.Info["integrationID"]>,
  }
}

/* ---------------------------------- sessions --------------------------------- */

/**
 * The session for one request, from the credential the host resolved for the provider's
 * integration. The host already refreshed a stale OAuth credential (through our `refresh`) and
 * already read KIRO_API_KEY for the env method; validation is all that is left here.
 */
async function sessionFor(ctx: Context, providerID: string, dependencies: KiroPluginDependencies): Promise<KiroSession> {
  const login = `Run \`opencode auth login ${providerID}\`.`
  const connection = await ctx.integration.connection.active(providerID)
  if (!connection) throw new KiroAuthError(`Kiro is not signed in for ${providerID}. ${login}`)
  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential) throw new KiroAuthError(`The ${providerID} credential is unavailable. ${login}`)

  if (providerID === API_PROVIDER_ID) {
    if (credential.type !== "key") throw new KiroAuthError(`${providerID} expects an API key credential. ${login}`)
    return createSession({ mode: "api", key: credential.key }, dependencies)
  }
  if (credential.type !== "oauth" || !credential.access) {
    throw new KiroAuthError(`${providerID} expects a device-flow (OAuth) credential. ${login}`)
  }
  return createSession({ mode: "oauth", accessToken: credential.access }, dependencies)
}

/** The first connected Kiro integration, device-flow logins first, for calls with no model context. */
async function anySession(ctx: Context, dependencies: KiroPluginDependencies): Promise<KiroSession> {
  for (const providerID of [PROVIDER_ID, API_PROVIDER_ID]) {
    if (await ctx.integration.connection.active(providerID)) return sessionFor(ctx, providerID, dependencies)
  }
  throw new KiroAuthError(
    `Kiro web search needs a signed-in Kiro provider. Run \`opencode auth login ${PROVIDER_ID}\` or \`opencode auth login ${API_PROVIDER_ID}\`.`,
  )
}

/* ------------------------------ request rewrite ------------------------------ */

/**
 * http.request: map the Anthropic Messages request the host built into Kiro's
 * GenerateAssistantResponse call and hand the host that request to send.
 */
async function rewriteRequest(
  event: SessionHttpRequest,
  ctx: Context,
  pending: WeakMap<Request, PendingChat>,
  dependencies: KiroPluginDependencies,
): Promise<void> {
  const debug = createKiroDebugContext()
  const providerID = event.model.providerID
  const text = await event.request.text()
  const body = text.length > 0 ? parseRequestObject(text) : {}
  if (!body) {
    throw new KiroRequestError("Invalid JSON request body: the Anthropic request must be a JSON object.")
  }
  // `model` is the wire id Kiro receives; the catalog entry is keyed by the host's model id, which
  // differs for a config alias (`modelID` pointing at another id) and carries the alias's limits.
  const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL
  const catalog = await catalogModel(ctx, providerID, [event.model.id, model])
  // The host names the unselected variant "default"; only a variant the model declares is effort.
  const variant = event.model.variant
  const effort = variant !== undefined && catalog.variants.includes(variant) ? variant : undefined

  kiroDebug(debug, "request.received", {
    provider: providerID,
    authMode: providerID === API_PROVIDER_ID ? "api" : "oauth",
    kind: event.kind,
    model,
    variant: variant ?? null,
    effort: effort ?? null,
    anthropicRequestBytes: Buffer.byteLength(text),
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
  })

  const payload = toKiroPayload(body, { effort, debug, cwd: () => ctx.location.directory })
  const session = await sessionFor(ctx, providerID, dependencies)
  const chat = await buildChatRequest(payload, session, { debug })

  const request = new Request(chat.url, { method: chat.method, headers: chat.headers, body: chat.body })
  pending.set(request, { debug, model, contextLimit: catalog.contextLimit })
  event.request = request
}

/** http.response: every upstream Response, 2xx or not, goes through the single response seam. */
async function rewriteResponse(event: SessionHttpResponse, pending: WeakMap<Request, PendingChat>): Promise<void> {
  const chat = pending.get(event.request)
  if (!chat) return
  pending.delete(event.request)
  kiroDebug(chat.debug, "response.received", {
    status: event.response.status,
    statusText: event.response.statusText,
    headers: responseDebugHeaders(event.response.headers),
  })
  event.response = await kiroResponseToAnthropic(event.response, {
    model: chat.model,
    contextLimit: chat.contextLimit,
    debug: chat.debug,
  })
}

/** What the request mapping needs from the host's catalog entry for a model. */
type CatalogModel = {
  contextLimit: number
  /** Declared variant ids; the effort levels this model accepts. */
  variants: string[]
}

/**
 * The model's catalog entry from the host's active catalog (our defaults plus the user's config
 * overlays). Never throws: an unavailable catalog yields the default window and no variants for
 * this request, so effort is dropped rather than guessed.
 */
async function catalogModel(ctx: Context, providerID: string, modelIDs: readonly string[]): Promise<CatalogModel> {
  try {
    const { data } = await ctx.model.list()
    const model = modelIDs
      .map((id) => data.find((entry) => entry.providerID === providerID && entry.id === id))
      .find((entry) => entry !== undefined)
    const context = model?.limit.context
    return {
      contextLimit: typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_LIMIT,
      variants: (model?.variants ?? []).map((variant) => String(variant.id)),
    }
  } catch {
    return { contextLimit: DEFAULT_CONTEXT_LIMIT, variants: [] }
  }
}

/* --------------------------------- web search -------------------------------- */

function registerWebSearch(editor: WebSearchEditor, ctx: Context, dependencies: KiroPluginDependencies): void {
  editor.add({
    id: PROVIDER_ID as WebSearch.ID,
    name: "Kiro",
    execute: async ({ query }, { signal }) =>
      kiroWebSearch(await anySession(ctx, dependencies), query, dependencies, signal),
  })
}

/** Kiro's InvokeMCP web_search results in the host's shape; entries without a URL are dropped. */
export async function kiroWebSearch(
  session: KiroSession,
  query: string,
  dependencies: KiroPluginDependencies,
  signal?: AbortSignal,
): Promise<WebSearch.Result[]> {
  const results = await webSearch(session, query, dependencies, signal)
  return results.flatMap((result) => {
    if (!result.url) return []
    const published = typeof result.publishedDate === "number" ? result.publishedDate : undefined
    return [
      {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        ...(result.snippet ? { content: result.snippet } : {}),
        time: published === undefined ? {} : { published },
      },
    ]
  })
}

/* ----------------------------------- helpers --------------------------------- */

/** Parse an Anthropic request body, accepting only a JSON object; anything else is undefined. */
function parseRequestObject(text: string): Record<string, any> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

function responseDebugHeaders(headers: Headers): Record<string, string> {
  const selected = [
    "content-type",
    "content-length",
    "x-amzn-requestid",
    "x-amzn-request-id",
    "x-amz-request-id",
    "x-amzn-trace-id",
  ]
  return Object.fromEntries(selected.flatMap((name) => (headers.has(name) ? [[name, headers.get(name) ?? ""]] : [])))
}
