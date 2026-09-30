import { getProfile, type KiroClientDependencies } from "./client"
import { KIRO_MANAGEMENT_ENDPOINTS } from "./constants"
import { redactKiroSecrets } from "./debug"

const API_KEY_PREFIX = "ksk_"
const API_KEY_PATTERN = /^ksk_[A-Za-z0-9._~+\/=:-]+$/

export class KiroApiKeyError extends Error {}

export function normalizeApiKey(value: string): string {
  const key = value.trim()
  if (!key) {
    throw new KiroApiKeyError("Kiro credential is empty.")
  }
  // The alphabet is the one redactKiroSecrets matches: a key with anything else in it (an embedded
  // line break, a zero-width space) could not be fully redacted from a transport error.
  if (!key.startsWith(API_KEY_PREFIX) || !API_KEY_PATTERN.test(key)) {
    throw new KiroApiKeyError("Kiro credential is invalid.")
  }
  return key
}

export async function fetchApiKeyProfileArn(
  key: string,
  dependencies: KiroClientDependencies = {},
): Promise<string> {
  const failures: string[] = []
  for (const endpoint of KIRO_MANAGEMENT_ENDPOINTS) {
    const region = new URL(endpoint).host
    let response: Response
    try {
      response = await getProfile(key, endpoint, dependencies)
    } catch (error) {
      failures.push(`${region}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!response.ok) {
      failures.push(`${region}: HTTP ${response.status}`)
      continue
    }

    // An ok response can still be unusable; fall through to the next region.
    const data = (await response.json().catch(() => null)) as { profile?: { arn?: unknown } } | null
    const arn = data?.profile?.arn
    if (typeof arn === "string" && arn.length > 0) return arn
    failures.push(`${region}: ${data === null ? "non-JSON response" : "response has no profile ARN"}`)
  }

  // Region hosts and failure reasons are safe to surface; the credential itself never is.
  throw new KiroApiKeyError(
    "Kiro could not use the configured credential. Verify it is active and try again. " +
      `(${redactKiroSecrets(failures.join("; "))})`,
  )
}
