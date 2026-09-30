import { normalizeApiKey } from "./apikey"
import type { KiroClientDependencies } from "./client"
import { getApiKeyProfileArn, getProfileArn } from "./profile"

export type KiroSession = {
  authHeaders: () => Promise<Record<string, string>>
  chatProfileArn: () => Promise<string | undefined>
  mcpProfileArn: () => Promise<string>
}

/** Session for the device-flow logins, over the access token the host resolved for this request. */
function createOAuthSession(accessToken: string, dependencies: KiroClientDependencies = {}): KiroSession {
  const profileArn = () => getProfileArn(accessToken, dependencies)

  return {
    async authHeaders() {
      return { authorization: `Bearer ${accessToken}` }
    },
    chatProfileArn: profileArn,
    mcpProfileArn: profileArn,
  }
}

export function createApiKeySession(key: string, dependencies: KiroClientDependencies = {}): KiroSession {
  const validated = normalizeApiKey(key)

  return {
    async authHeaders() {
      return {
        authorization: `Bearer ${validated}`,
        tokentype: "API_KEY",
      }
    },
    async chatProfileArn() {
      return undefined
    },
    mcpProfileArn() {
      return getApiKeyProfileArn(validated, dependencies)
    },
  }
}

/**
 * What a session is built from. The discriminant is first-class: an OAuth session is backed by the
 * access token of the credential the host resolved (and, when stale, refreshed through the
 * plugin's `refresh`), an API-key session by the key the host resolved (stored, or KIRO_API_KEY
 * for the env method). Pure over its inputs: the host adapter owns every credential read.
 */
export type SessionSpec = { mode: "oauth"; accessToken: string } | { mode: "api"; key: string }

export function createSession(spec: SessionSpec, dependencies: KiroClientDependencies = {}): KiroSession {
  return spec.mode === "api"
    ? createApiKeySession(spec.key, dependencies)
    : createOAuthSession(spec.accessToken, dependencies)
}
