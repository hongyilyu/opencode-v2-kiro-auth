import type { Credential, Plugin } from "@opencode/plugin"
import type {
  IntegrationEditor,
  IntegrationMethod,
  IntegrationMethodRegistration,
} from "@opencode/plugin/promise/integration"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"

type Connection = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>
type ModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type SessionHook<Name extends keyof SessionHooks> = (event: SessionHooks[Name]) => Promise<void> | void

/** What a v2 plugin registered against the fake host, in the shape the real host would hold it. */
export type FakeHostState = {
  integrations: Map<string, { name: string; methods: IntegrationMethodRegistration[] }>
  providers: Map<string, { info: Parameters<ProviderEditor["add"]>[0]["info"]; models: ModelInfo[] }>
  webSearch: WebSearchDefinition[]
  webSearchDefault: string | false | undefined
  hooks: { [Name in keyof SessionHooks]: Array<{ providerID?: string; callback: SessionHook<Name> }> }
}

/** Per-integration credentials the fake host "stores"; `resolve` answers from here. */
export type FakeCredentials = Record<string, Credential.Value | undefined>

/** The directory the fake host's plugin instance serves (its `ctx.location`). */
export const FAKE_LOCATION_DIRECTORY = "/work/project"

/**
 * A fake opencode v2 plugin context: transforms run their editor callback immediately and record
 * what was registered; session hooks are recorded for the test to invoke; the integration
 * connection API answers from `credentials`; `model.list()` reports the registered catalog.
 */
export function fakeContext(options: { credentials?: FakeCredentials; directory?: string } = {}) {
  const credentials: FakeCredentials = { ...options.credentials }
  const state: FakeHostState = {
    integrations: new Map(),
    providers: new Map(),
    webSearch: [],
    webSearchDefault: undefined,
    hooks: {
      prompt: [],
      context: [],
      compaction: [],
      generate: [],
      title: [],
      "model.request": [],
      "http.request": [],
      "http.response": [],
      "experimental.ws.handshake": [],
      "experimental.ws.send": [],
      "experimental.ws.receive": [],
      retry: [],
    },
  }
  const registration = { dispose: async () => {} }

  const integrationEditor: IntegrationEditor = {
    list: () => Array.from(state.integrations, ([id, entry]) => ({ id, name: entry.name })),
    get: (id) => (state.integrations.has(id) ? { id, name: state.integrations.get(id)!.name } : undefined),
    update: (id, update) => {
      const entry = state.integrations.get(id) ?? { name: id, methods: [] }
      state.integrations.set(id, entry)
      const ref = { id, name: entry.name }
      update(ref)
      entry.name = ref.name
    },
    remove: (id) => void state.integrations.delete(id),
    method: {
      list: (integrationID) => state.integrations.get(integrationID)?.methods.map((m) => m.method) ?? [],
      update: (input) => {
        const entry = state.integrations.get(input.integrationID) ?? { name: input.integrationID, methods: [] }
        state.integrations.set(input.integrationID, entry)
        entry.methods.push(input)
      },
      remove: (integrationID: string, method: IntegrationMethod) => {
        const entry = state.integrations.get(integrationID)
        if (entry) entry.methods = entry.methods.filter((m) => m.method !== method)
      },
    },
  }

  const providerEditor = {
    list: () => Array.from(state.providers.values(), (p) => ({ provider: p.info, models: new Map(p.models.map((m) => [m.id, m])) })),
    get: (id: string) => {
      const p = state.providers.get(id)
      return p && { provider: p.info, models: new Map(p.models.map((m) => [m.id, m])) }
    },
    add: (input: Parameters<ProviderEditor["add"]>[0]) =>
      void state.providers.set(input.info.id, { info: input.info, models: [...input.models] as unknown as ModelInfo[] }),
    update: () => {},
    remove: (id: string) => void state.providers.delete(id),
    models: { set: () => {}, update: () => {}, remove: () => {} },
  } as unknown as ProviderEditor

  const webSearchEditor: WebSearchEditor = {
    add: (definition) => void state.webSearch.push(definition),
    default: {
      get: () => state.webSearchDefault,
      set: (selection) => void (state.webSearchDefault = selection),
    },
  }

  const connectionFor = (integrationID: string): Connection => {
    const credential = credentials[integrationID]
    if (!credential) return undefined
    return credential.type === "key" && credential.metadata?.env === true
      ? { type: "env", name: "KIRO_API_KEY" }
      : { type: "credential", id: `cred_${integrationID}`, label: integrationID, method: credential.type }
  }

  const ctx = {
    app: { name: "test", version: "2.0.20", channel: "latest" },
    location: {
      directory: options.directory ?? FAKE_LOCATION_DIRECTORY,
      project: { id: "prj_test", directory: "/work/project", canonical: "/work/project" },
    },
    integration: {
      transform: async (callback: (editor: IntegrationEditor) => void) => (callback(integrationEditor), registration),
      connection: {
        active: async (integrationID: string) => connectionFor(integrationID),
        resolve: async (connection: NonNullable<Connection>) => {
          const id = connection.type === "env" ? "kiro-api" : connection.id.slice("cred_".length)
          return credentials[id]
        },
        status: async () => {},
      },
    },
    provider: { transform: async (callback: (editor: ProviderEditor) => void) => (callback(providerEditor), registration) },
    websearch: { transform: async (callback: (editor: WebSearchEditor) => void) => (callback(webSearchEditor), registration) },
    model: {
      list: async () => ({
        location: {},
        data: Array.from(state.providers.values()).flatMap((p) => p.models),
      }),
    },
    session: {
      hook: async <Name extends keyof SessionHooks>(
        name: Name,
        callback: SessionHook<Name>,
        options?: { providerID?: string },
      ) => {
        state.hooks[name].push({ providerID: options?.providerID, callback: callback as never })
        return registration
      },
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    state,
    credentials,
    /** Run every recorded hook of `name` whose provider scope matches the event's provider. */
    async trigger<Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]): Promise<void> {
      const providerID = (event as { model?: { providerID?: string } }).model?.providerID
      for (const hook of state.hooks[name]) {
        if (hook.providerID !== undefined && hook.providerID !== providerID) continue
        await hook.callback(event)
      }
    },
  }
}

export type FakeContext = ReturnType<typeof fakeContext>

/** A `model` ref as the host passes it to session hooks. */
export function modelRef(providerID: string, id: string, variant?: string) {
  return { providerID, id, ...(variant ? { variant } : {}) } as SessionHooks["http.request"]["model"]
}

/** The http.request event the host would build for an Anthropic Messages POST. */
export function httpRequestEvent(
  providerID: string,
  body: unknown,
  options: { modelID?: string; variant?: string; kind?: SessionHooks["http.request"]["kind"] } = {},
): SessionHooks["http.request"] {
  const modelID = options.modelID ?? (body as { model?: string })?.model ?? "claude-opus-5.5"
  return {
    sessionID: "ses_test" as SessionHooks["http.request"]["sessionID"],
    agent: "build" as SessionHooks["http.request"]["agent"],
    model: modelRef(providerID, modelID, options.variant),
    kind: options.kind ?? "primary",
    request: new Request("https://kiro.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: "Bearer host" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  }
}

export function httpResponseEvent(
  request: SessionHooks["http.request"],
  response: Response,
): SessionHooks["http.response"] {
  return {
    sessionID: request.sessionID,
    agent: request.agent,
    model: request.model,
    kind: request.kind,
    request: request.request,
    response,
  }
}
