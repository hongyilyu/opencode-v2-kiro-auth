import { describe, expect, it } from "bun:test"
import { encodeKiroEvent } from "./support/eventstream-fixtures"
import {
  convert,
  errorBody,
  expectEventStream,
  expectTerminalError,
  parseSse,
  preflight,
  steppedResponse,
} from "./support/response-fixtures"

// eventstream has no resync marker: a lying prelude makes every later byte garbage, so the
// driver delivers what decoded, then fails for good on the same channel as a transport error.
describe("framing faults", () => {
  const corruptFrame = () => {
    const frame = encodeKiroEvent("assistantResponseEvent", { content: "garbage" })
    frame.writeUInt32BE(0xffff, 4)
    return frame
  }

  it("a pre-output framing fault is a 502, never a timeout", async () => {
    const upstream = steppedResponse([
      Buffer.concat([encodeKiroEvent("contextUsageEvent", { contextUsagePercentage: 5 }), corruptFrame()]),
      encodeKiroEvent("assistantResponseEvent", { content: "never read" }),
      "eof",
    ])
    const res = await convert(upstream.response)

    expect(res.status).toBe(502)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toMatch(/framing/i)
    expect(body.error?.message).not.toMatch(/timeout|timed out/i)
    expect(upstream.stats()).toMatchObject({ reads: 1, cancels: 1, releases: 1, remainingSteps: 2 })
  })

  it("frames decoded before a pre-output fault still drive the verdict", async () => {
    const throttled = encodeKiroEvent("ThrottlingException", { message: "Rate exceeded" }, ":exception-type")
    const res = await preflight(Buffer.concat([throttled, corruptFrame()]))

    expect(res.status).toBe(429)
    expect((await errorBody(res)).error?.type).toBe("rate_limit_error")
  })

  it("stops reading after a framing fault", async () => {
    const upstream = steppedResponse([
      Buffer.concat([encodeKiroEvent("assistantResponseEvent", { content: "before" }), corruptFrame()]),
      encodeKiroEvent("assistantResponseEvent", { content: "after" }),
      "eof",
    ])
    const response = await convert(upstream.response)
    const frames = parseSse(await response.text())

    expectEventStream(response)
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(frames.some((frame) => frame.data.delta?.text === "after")).toBe(false)
    const message: string = frames.at(-1)?.data.error.message
    expect(message).toMatch(/framing/i)
    expect(message).not.toMatch(/timeout|timed out/i)
    expectTerminalError(frames)

    const stats = upstream.stats()
    expect(stats).toMatchObject({ reads: 1, cancels: 1, releases: 1, remainingSteps: 2 })
    expect(String(stats.cancelReason)).toMatch(/framing/i)
  })

  // Kiro closing the socket inside a frame is not a completed turn (D3): the bytes that never
  // arrived may have been the tool stop or the rest of the text.
  it("a stream that ends inside a frame after output is a terminal error, not a completed turn", async () => {
    const secondFrame = encodeKiroEvent("assistantResponseEvent", { content: "never finished" })
    const response = await preflight(
      encodeKiroEvent("assistantResponseEvent", { content: "before" }),
      secondFrame.subarray(0, 20),
    )
    const frames = parseSse(await response.text())

    expectEventStream(response)
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(frames.some((frame) => frame.data.delta?.text === "never finished")).toBe(false)
    const message: string = frames.at(-1)?.data.error.message
    expect(message).toMatch(/truncated-frame|framing/i)
    expect(message).not.toMatch(/timeout|timed out/i)
    expectTerminalError(frames)
  })

  it("a stream that ends inside a frame before output is a 502", async () => {
    const frame = encodeKiroEvent("assistantResponseEvent", { content: "never finished" })
    const res = await preflight(frame.subarray(0, 20))

    expect(res.status).toBe(502)
    const body = await errorBody(res)
    expect(body.error?.type).toBe("api_error")
    expect(body.error?.message).toMatch(/framing/i)
    expect(body.error?.message).not.toMatch(/timeout|timed out/i)
  })

  // A prelude claiming a 2 GiB frame is a lie the decoder can reject from the 12 prelude bytes
  // alone. Waiting for the frame to "complete" would silently swallow every later event.
  it("a lying prelude cannot swallow the rest of the stream", async () => {
    const lyingPrelude = Buffer.alloc(12)
    lyingPrelude.writeUInt32BE(0x7fffffff, 0)
    lyingPrelude.writeUInt32BE(0xffffffff, 4)
    const response = await preflight(
      encodeKiroEvent("assistantResponseEvent", { content: "first half" }),
      lyingPrelude,
      encodeKiroEvent("assistantResponseEvent", { content: " second half" }),
      encodeKiroEvent("toolUseEvent", { toolUseId: "swallowed", name: "bash", input: '{"command":"ls"}', stop: true }),
    )
    const sse = await response.text()
    const frames = parseSse(sse)

    expectEventStream(response)
    expect(sse).toContain('"text":"first half"')
    expect(sse).not.toContain("second half")
    expect(sse).not.toContain('"type":"tool_use"')
    expect(frames.at(-1)?.data.error.message).toMatch(/framing/i)
    expectTerminalError(frames)
  })
})

describe("transport failures before output", () => {
  it("redacts a credential carried in the transport error it reports", async () => {
    const res = await convert(steppedResponse([new Error("reset by peer Bearer sekrit-token ksk_transportkey")]).response)

    expect(res.status).toBe(502)
    const message = (await errorBody(res)).error?.message ?? ""
    expect(message).toContain("reset by peer")
    expect(message).toContain("Bearer <redacted>")
    expect(message).not.toContain("sekrit-token")
    expect(message).not.toContain("ksk_transportkey")
  })
})
