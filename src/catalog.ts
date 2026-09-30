import type { Model, Provider } from "@opencode/plugin"

/**
 * The default Kiro model catalog plugin.ts registers for both providers. Ids must match Kiro's
 * `ListAvailableModels` exactly (`kiro-cli chat --list-models` prints the live list for an
 * account). Limits and modalities mirror that listing; `variants` are the effort levels Kiro
 * exposes per model, which the request hook maps to `additionalModelRequestFields`. Users override
 * or extend any of this from `providers.<id>.models` in opencode.json — config transforms run
 * after plugin transforms, so config wins.
 */
export type KiroCatalogEntry = {
  id: string
  name: string
  context: number
  output: number
  /** Whether Kiro accepts image input for this model. */
  image: boolean
  variants?: readonly string[]
}

const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const
const GPT_EFFORT = ["none", "low", "medium", "high", "xhigh", "max"] as const

export const KIRO_MODEL_CATALOG: readonly KiroCatalogEntry[] = [
  { id: "claude-fable-5.1", name: "Claude Fable 5.1", context: 1_000_000, output: 128_000, image: true, variants: CLAUDE_EFFORT },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", context: 1_000_000, output: 128_000, image: true, variants: CLAUDE_EFFORT },
  { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", context: 1_000_000, output: 128_000, image: true, variants: GPT_EFFORT },
]

/** One catalog entry as the host's immutable model definition under `providerID`. */
export function toModelInfo(entry: KiroCatalogEntry, providerID: string): Model.Info {
  return {
    id: entry.id as Model.ID,
    modelID: entry.id as Model.ID,
    providerID: providerID as Provider.ID,
    name: entry.name,
    capabilities: { tools: true, input: entry.image ? ["text", "image"] : ["text"], output: ["text"] },
    variants: (entry.variants ?? []).map((id) => ({ id: id as Model.VariantID })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: entry.context, output: entry.output },
  }
}

export function kiroModels(providerID: string, catalog: readonly KiroCatalogEntry[] = KIRO_MODEL_CATALOG): Model.Info[] {
  return catalog.map((entry) => toModelInfo(entry, providerID))
}
