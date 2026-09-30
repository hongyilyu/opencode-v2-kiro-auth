// End-to-end check of opencode-v2-kiro-auth against a real Kiro account. Never prints
// tokens.
//
// Usage: bun run check [model]
//        bun run script/check.ts [model]
// The model defaults to claude-opus-5.5.
//
// Needs an opencode 2.x binary on PATH (`opencode2`, or `opencode` if it reports v2.x), or
// OPENCODE2_BIN pointing at one. The run uses your real opencode 2.x config and credentials, so
// sign in first with `opencode auth login kiro`. The script appends this checkout to `plugins`,
// which means the code under test is this working tree, not a published version. That holds only
// when your config doesn't already load this plugin: opencode keeps the first plugin with a given
// id and drops this checkout as a duplicate, so remove an npm or GitHub entry before the check.
// It runs `auth list`, one chat through kiro/<model>, and one built-in websearch call routed to the
// kiro backend, all with --standalone.
import { spawnSync } from "node:child_process"

const model = process.argv[2] ?? "claude-opus-5.5"
const bin = process.env.OPENCODE2_BIN ?? (spawnSync("opencode2", ["--version"]).status === 0 ? "opencode2" : "opencode")

const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? ""
if (!/\bv?2\./.test(version)) {
  console.error(`script/check.ts needs an opencode 2.x binary; "${bin} --version" printed: ${version || "(nothing)"}`)
  process.exit(2)
}

const localPlugin = new URL("../", import.meta.url).href
let config: Record<string, unknown> = {}
try {
  config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
} catch {
  throw new Error("OPENCODE_CONFIG_CONTENT must be valid JSON.")
}
const plugins = Array.isArray(config.plugins) ? config.plugins : []

const run = (args: string[]) => {
  const result = spawnSync(bin, args, {
    // Never hand opencode our stdin: `opencode run` reads a piped stdin into the prompt and waits
    // for EOF, so an open pipe (CI, an agent shell) would hang the check.
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...plugins, localPlugin], websearch: { provider: "kiro" } }) },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.error(`# ${bin} ${version}: integrations`)
run(["auth", "list", "--standalone"])
console.error(`# chat through kiro/${model}`)
run(["run", "Reply with exactly: ok", "--model", `kiro/${model}`, "--standalone"])
console.error(`# built-in websearch through the kiro backend`)
run([
  "run",
  "Use the websearch tool to find the current Node.js LTS version. Answer in one line and cite one URL.",
  "--model",
  `kiro/${model}`,
  "--standalone",
  "--auto",
])
