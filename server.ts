// opencode v2 entrypoint. The loader reads the default export: `exports["./server"]` for an npm
// install, `server.ts` first for a local directory.
import { KiroPlugin } from "./src/plugin"

export default KiroPlugin
