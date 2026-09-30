import { afterEach, describe, expect, it, mock, setSystemTime, spyOn } from "bun:test"
import * as crypto from "node:crypto"
import { platform } from "node:os"
import { fetchApiKeyProfileArn } from "../src/apikey"
import { buildChatRequest } from "../src/client"
import { kiroOperatingSystem } from "../src/constants"
import { invokeMcp } from "../src/mcp"
import { getProfileArn } from "../src/profile"
import { toKiroPayload } from "../src/request"
import { fakeSession } from "./support/pipeline-fixtures"

/** Headers as entries: toEqual compares arrays in order, so every capture below pins header order. */
type WireCall = {
  url: string
  method: string | undefined
  headers: [string, string][]
  body: string | undefined
}

const ACCESS_TOKEN = "wire-access-token"
const API_KEY = "ksk_wiretestkey"
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/WIRETEST"
const DEBUG_ID = "00000000-0000-4000-8000-000000000001"
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002"
const CONTINUATION_ID = "00000000-0000-4000-8000-000000000003"
const MCP_INVOCATION_ID = "00000000-0000-4000-8000-000000000004"
const FIXED_TIME = new Date("2026-08-24T12:34:56.789Z")

const kiroOs = kiroOperatingSystem(platform())
const STREAMING_USER_AGENT =
  `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${kiroOs} ` +
  "lang/rust/1.92.0 md/appVersion-2.18.0 app/AmazonQ-For-CLI"
const STREAMING_X_AMZ_USER_AGENT =
  `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${kiroOs} ` +
  "lang/rust/1.92.0 m/F app/AmazonQ-For-CLI"
const MANAGEMENT_USER_AGENT =
  `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/${kiroOs} ` +
  "lang/rust/1.92.0 md/appVersion-2.18.0 app/AmazonQ-For-CLI"

afterEach(() => {
  setSystemTime()
  mock.restore()
})

function wireCall(url: string, init: RequestInit = {}): WireCall {
  // A Headers instance iterates in sorted order; only a plain record carries the order it was built in.
  if (init.headers instanceof Headers || Array.isArray(init.headers)) throw new Error("expected a header record")
  const headers = Object.entries(init.headers ?? {})
  return {
    url,
    method: init.method,
    headers: headers.map(([name, value]): [string, string] => [name, String(value)]),
    body: typeof init.body === "string" ? init.body : undefined,
  }
}

function recordingFetch(
  respond: (call: WireCall, index: number) => Response = () => new Response("{}"),
): { calls: WireCall[]; fetch: typeof globalThis.fetch } {
  const calls: WireCall[] = []
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const call = wireCall(input instanceof Request ? input.url : String(input), init)
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function localTimestamp(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" })
  const pad = (value: number, length = 2) => String(value).padStart(length, "0")
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const absoluteOffset = Math.abs(offsetMinutes)
  return (
    `${weekday}, ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(absoluteOffset / 60))}:` +
    pad(absoluteOffset % 60)
  )
}

const session = fakeSession({ token: ACCESS_TOKEN, profileArn: PROFILE_ARN })

describe("Kiro request wire captures", () => {
  it("renders GenerateAssistantResponse without dialing", async () => {
    setSystemTime(FIXED_TIME)
    spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(CONVERSATION_ID)
      .mockReturnValueOnce(CONTINUATION_ID)
    const dial = spyOn(globalThis, "fetch").mockRejectedValue(new Error("buildChatRequest dialed"))

    const debug = { id: DEBUG_ID, startedAt: FIXED_TIME.getTime(), enabled: false }
    const request = await buildChatRequest(
      toKiroPayload(
        { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "hello" }] },
        { debug },
      ),
      session,
      { debug },
    )

    expect(dial).not.toHaveBeenCalled()
    expect(wireCall(request.url, request)).toEqual({
      url: "https://runtime.us-east-1.kiro.dev/",
      method: "POST",
      headers: Object.entries({
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        "user-agent": STREAMING_USER_AGENT,
        "x-amz-user-agent": STREAMING_X_AMZ_USER_AGENT,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": DEBUG_ID,
        "amz-sdk-request": "attempt=1; max=3",
      }),
      body: JSON.stringify({
        profileArn: PROFILE_ARN,
        conversationState: {
          conversationId: CONVERSATION_ID,
          currentMessage: {
            userInputMessage: {
              content:
                "--- CONTEXT ENTRY BEGIN ---\n" +
                `Current time: ${localTimestamp(FIXED_TIME)}\n` +
                "--- CONTEXT ENTRY END ---\n\n" +
                "--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---",
              userInputMessageContext: {
                envState: {
                  operatingSystem: kiroOs,
                  currentWorkingDirectory: process.cwd(),
                  environmentVariables: [],
                },
              },
              origin: "KIRO_CLI",
              modelId: "claude-sonnet-4.6",
            },
          },
          history: [],
          chatTriggerType: "MANUAL",
          agentContinuationId: CONTINUATION_ID,
          agentTaskType: "vibe",
        },
      }),
    })
  })

  it("buildChatRequest accepts only a typed KiroRequestPayload", () => {
    // Compile-time contract: the closure is never invoked; `bun run typecheck` fails if the
    // expected error disappears (a loosely typed body would then reach the wire unchecked).
    const debug = { id: DEBUG_ID, startedAt: FIXED_TIME.getTime(), enabled: false }
    const renderRawObject = () =>
      // @ts-expect-error a raw object is not a KiroRequestPayload
      buildChatRequest({ conversationState: {} } as Record<string, unknown>, session, { debug })
    expect(typeof renderRawObject).toBe("function")
  })

  it("captures InvokeMCP", async () => {
    spyOn(crypto, "randomUUID").mockReturnValueOnce(MCP_INVOCATION_ID)
    const recorder = recordingFetch(() => new Response('{"result":{}}'))

    await invokeMcp(session, "tools/call", { name: "web_search", arguments: { query: "wire" } }, {
      fetch: recorder.fetch,
    })

    expect(recorder.calls).toEqual([
      {
        url: "https://q.us-east-1.amazonaws.com/",
        method: "POST",
        headers: Object.entries({
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "x-amzn-kiro-profile-arn": PROFILE_ARN,
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererStreamingService.InvokeMCP",
          "user-agent": STREAMING_USER_AGENT,
          "x-amz-user-agent": STREAMING_X_AMZ_USER_AGENT,
          "x-amzn-codewhisperer-optout": "false",
          "amz-sdk-invocation-id": MCP_INVOCATION_ID,
          "amz-sdk-request": "attempt=1; max=1",
        }),
        body: JSON.stringify({
          profileArn: PROFILE_ARN,
          jsonrpc: "2.0",
          id: "1",
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "wire" } },
        }),
      },
    ])
  })

  it("captures ListAvailableProfiles", async () => {
    const recorder = recordingFetch(() => new Response(JSON.stringify({ profiles: [{ arn: PROFILE_ARN }] })))

    expect(await getProfileArn(ACCESS_TOKEN, { fetch: recorder.fetch })).toBe(PROFILE_ARN)
    expect(recorder.calls).toEqual([
      {
        url: "https://management.us-east-1.kiro.dev/?origin=KIRO_CLI",
        method: "POST",
        headers: Object.entries({
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
          "user-agent": MANAGEMENT_USER_AGENT,
          "x-amz-user-agent": MANAGEMENT_USER_AGENT,
          "x-amzn-codewhisperer-optout": "false",
        }),
        body: "{}",
      },
    ])
  })

  it("captures GetProfile region fallback", async () => {
    const recorder = recordingFetch((_call, index) =>
      index === 0
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ profile: { arn: PROFILE_ARN } })),
    )

    expect(await fetchApiKeyProfileArn(API_KEY, { fetch: recorder.fetch })).toBe(PROFILE_ARN)
    const request = {
      method: "POST",
      headers: Object.entries({
        authorization: `Bearer ${API_KEY}`,
        tokentype: "API_KEY",
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.GetProfile",
        "user-agent": MANAGEMENT_USER_AGENT,
        "x-amz-user-agent": MANAGEMENT_USER_AGENT,
      }),
      body: "{}",
    }
    expect(recorder.calls).toEqual([
      { url: "https://management.us-east-1.kiro.dev/", ...request },
      { url: "https://management.eu-central-1.kiro.dev/", ...request },
    ])
  })
})
