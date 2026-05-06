import { describe, it, expect } from "vitest";
import {
  resolveApiKey,
  convertMessages,
  convertTools,
  parseStreamEventLine,
  parseNDJSON,
  processStreamEvent,
  createStreamState,
  buildRequestBody,
  closeOpenBlocks,
  mapStopReason,
  sanitizeApiKey,
  raceAbort,
  abortError,
} from "../../src/logic.js";

// ─── resolveApiKey ──────────────────────────────────────────────────────────

describe("resolveApiKey", () => {
  it("returns provided key first", () => {
    expect(resolveApiKey("user_provided")).toBe("user_provided");
  });

  it("falls back to env var", () => {
    expect(
      resolveApiKey(undefined, { env: { COMMANDCODE_API_KEY: "user_env" } }),
    ).toBe("user_env");
  });

  it("falls back to auth.json with apiKey field", () => {
    const readFile = () => JSON.stringify({ apiKey: "user_from_file" });
    const fileExists = () => true;
    expect(
      resolveApiKey(undefined, { readFile, fileExists }),
    ).toBe("user_from_file");
  });

  it("falls back to auth.json with commandcode string field", () => {
    const readFile = () => JSON.stringify({ commandcode: "user_cc_string" });
    const fileExists = () => true;
    expect(
      resolveApiKey(undefined, { readFile, fileExists }),
    ).toBe("user_cc_string");
  });

  it("falls back to auth.json with OAuth credentials", () => {
    const readFile = () =>
      JSON.stringify({
        commandcode: { type: "oauth", access: "user_oauth_key", refresh: "user_oauth_key" },
      });
    const fileExists = () => true;
    expect(
      resolveApiKey(undefined, { readFile, fileExists }),
    ).toBe("user_oauth_key");
  });

  it("checks ~/.pi/agent/auth.json as fallback", () => {
    const readFile = (p: string) => {
      if (p.includes("commandcode")) throw new Error("ENOENT");
      return JSON.stringify({ apiKey: "user_from_pi_auth" });
    };
    const fileExists = (p: string) => !p.includes("commandcode");
    expect(
      resolveApiKey(undefined, {
        readFile,
        fileExists,
        authPaths: ["/home/.commandcode/auth.json", "/home/.pi/agent/auth.json"],
      }),
    ).toBe("user_from_pi_auth");
  });

  it("returns undefined when no key is available", () => {
    const readFile = () => {
      throw new Error("ENOENT");
    };
    const fileExists = () => false;
    expect(resolveApiKey(undefined, { readFile, fileExists })).toBeUndefined();
  });

  it("skips malformed auth.json", () => {
    const readFile = () => "not json";
    const fileExists = () => true;
    expect(resolveApiKey(undefined, { readFile, fileExists })).toBeUndefined();
  });
});

// ─── convertMessages (native CC format) ─────────────────────────────────────

describe("convertMessages", () => {
  it("converts a simple user string message", () => {
    const result = convertMessages([
      { role: "user", content: "Hello" },
    ]);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts user content array passthrough", () => {
    const content = [
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ];
    const result = convertMessages([{ role: "user", content }]);
    // CC native: content array is passed through as-is
    expect(result[0].role).toBe("user");
    expect(Array.isArray(result[0].content)).toBe(true);
  });

  it("converts assistant message with text to CC native content array", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    ]);
  });

  it("converts assistant message with tool call to CC native format", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          {
            type: "toolCall",
            id: "call_123",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123",
        content: "file list",
      },
    ]);
    const assistant = result[0];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]).toEqual({ type: "text", text: "Let me check" });
    expect(assistant.content[1]).toEqual({
      type: "tool-call",
      toolCallId: "call_123",
      toolName: "bash",
      input: { command: "ls" },
    });
  });

  it("converts toolResult to CC native tool-result format", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "test.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: "file content",
      },
    ]);
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read",
          output: { type: "text", value: "file content" },
        },
      ],
    });
  });

  it("marks error tool results with error-text type", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_err", name: "bash", arguments: { command: "false" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_err",
        toolName: "bash",
        content: "command failed",
        isError: true,
      },
    ]);
    expect(result[1].content[0].output.type).toBe("error-text");
    expect(result[1].content[0].output.value).toBe("command failed");
  });

  it("omits tool calls without matching tool results", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "orphan", name: "read", arguments: {} },
        ],
      },
    ]);
    // Orphan tool call should be filtered out, leaving empty content array
    expect(result).toHaveLength(0);
  });

  it("converts thinking content to CC reasoning format", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here's the answer" },
        ],
      },
    ]);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: "reasoning", text: "Let me think..." });
    expect(result[0].content[1]).toEqual({ type: "text", text: "Here's the answer" });
  });
});

// ─── convertTools (native CC format) ────────────────────────────────────────

describe("convertTools", () => {
  it("converts tools to CC native format with input_schema", () => {
    const result = convertTools([
      {
        name: "bash",
        description: "Execute a bash command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("function");
    expect(result[0].name).toBe("bash");
    expect(result[0].description).toBe("Execute a bash command");
    expect(result[0].input_schema).toBeDefined();
    expect(result[0].input_schema.type).toBe("object");
    expect(result[0].input_schema.properties).toBeDefined();
  });

  it("handles tools without description", () => {
    const result = convertTools([{ name: "my_tool" }]);
    expect(result[0].description).toBe("");
  });

  it("handles tools without parameters", () => {
    const result = convertTools([{ name: "noop" }]);
    expect(result[0].input_schema).toEqual({});
  });

  it("returns empty array for empty input", () => {
    expect(convertTools([])).toEqual([]);
  });

  it("returns empty array for null/undefined", () => {
    expect(convertTools(null as any)).toEqual([]);
    expect(convertTools(undefined as any)).toEqual([]);
  });
});

// ─── toJsonSchema ────────────────────────────────────────────────────────

describe("toJsonSchema", () => {
  it("converts TypeBox-style schemas to JSON Schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    // Our convertTools uses toJsonSchema internally
    const result = convertTools([
      { name: "test", parameters: schema },
    ]);
    expect(result[0].input_schema).toEqual(schema);
  });

  it("converts enum types", () => {
    // toJsonSchema is used internally by convertTools
    const result = convertTools([{
      name: "test",
      parameters: { enum: ["a", "b", "c"] },
    }]);
    expect(result[0].input_schema).toEqual({ type: "string", enum: ["a", "b", "c"] });
  });

  it("converts optional fields", () => {
    const result = convertTools([{
      name: "test",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          opt: { type: "string", optional: true },
        },
      },
    }]);
    expect(result[0].input_schema.required).toEqual(["name"]);
  });
});

// ─── parseStreamEventLine ──────────────────────────────────────────────────

describe("parseStreamEventLine", () => {
  it("parses raw NDJSON line", () => {
    const result = parseStreamEventLine('{"type":"text-delta","text":"Hi"}');
    expect(result).toEqual({ type: "text-delta", text: "Hi" });
  });

  it("parses SSE data: prefix", () => {
    const result = parseStreamEventLine('data: {"type":"start"}');
    expect(result).toEqual({ type: "start" });
  });

  it("returns undefined for empty lines", () => {
    expect(parseStreamEventLine("")).toBeUndefined();
    expect(parseStreamEventLine("   ")).toBeUndefined();
  });

  it("returns undefined for SSE comments", () => {
    expect(parseStreamEventLine(": keep-alive")).toBeUndefined();
  });

  it("returns undefined for event: lines", () => {
    expect(parseStreamEventLine("event: message")).toBeUndefined();
  });

  it("returns undefined for [DONE]", () => {
    expect(parseStreamEventLine("[DONE]")).toBeUndefined();
    expect(parseStreamEventLine("data: [DONE]")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseStreamEventLine("not json")).toBeUndefined();
  });
});

// ─── parseNDJSON ────────────────────────────────────────────────────────

describe("parseNDJSON", () => {
  it("parses multiple NDJSON lines", () => {
    const result = parseNDJSON('{"type":"start"}\n{"type":"text-delta","text":"Hi"}\n');
    expect(result).toEqual([{ type: "start" }, { type: "text-delta", text: "Hi" }]);
  });
});

// ─── processStreamEvent ────────────────────────────────────────────────────

describe("processStreamEvent", () => {
  it("handles text-delta (auto-creates text block)", () => {
    const state = createStreamState();
    processStreamEvent({ type: "text-delta", text: "Hello " }, state);
    processStreamEvent({ type: "text-delta", text: "World" }, state);
    expect(state.content).toEqual([{ type: "text", text: "Hello World" }]);
  });

  it("handles text-start / text-delta / text-end sequence", () => {
    const state = createStreamState();
    processStreamEvent({ type: "text-start" }, state);
    expect(state.currentTextIndex).toBe(0);
    processStreamEvent({ type: "text-delta", text: "Hi" }, state);
    processStreamEvent({ type: "text-end" }, state);
    expect(state.content[0]).toEqual({ type: "text", text: "Hi" });
    expect(state.currentTextIndex).toBe(-1);
  });

  it("handles reasoning-delta → reasoning-end (thinking stream)", () => {
    const state = createStreamState();
    processStreamEvent({ type: "reasoning-start" }, state);
    processStreamEvent({ type: "reasoning-delta", text: "Let me " }, state);
    processStreamEvent({ type: "reasoning-delta", text: "think..." }, state);
    processStreamEvent({ type: "reasoning-end" }, state);

    expect(state.content).toHaveLength(1);
    expect(state.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." });

    const thinkingEvents = state.events.filter(
      (e: any) => e.type?.startsWith("thinking"),
    );
    expect(thinkingEvents).toHaveLength(3); // start, delta, end
    expect(thinkingEvents[0].type).toBe("thinking_start");
    expect(thinkingEvents[1].type).toBe("thinking_delta");
    expect(thinkingEvents[2].type).toBe("thinking_end");
  });

  it("handles tool-call event (CC native single-event format)", () => {
    const state = createStreamState();
    const emitted = processStreamEvent(
      {
        type: "tool-call",
        toolCallId: "tc_1",
        toolName: "bash",
        input: { command: "ls" },
      },
      state,
    );

    expect(state.content).toHaveLength(1);
    expect(state.content[0]).toEqual({
      type: "toolCall",
      id: "tc_1",
      name: "bash",
      arguments: { command: "ls" },
    });
    expect(emitted).toHaveLength(2); // toolcall_start + toolcall_end
    expect(emitted[0].type).toBe("toolcall_start");
    expect(emitted[1].type).toBe("toolcall_end");
  });

  it("handles tool-call-start/delta/end (streaming format)", () => {
    const state = createStreamState();
    processStreamEvent({ type: "tool-call-start", id: "tc_stream", name: "read" }, state);
    processStreamEvent(
      { type: "tool-call-delta", delta: '{"path":"test.ts"}' },
      state,
    );
    const emitted = processStreamEvent({ type: "tool-call-end" }, state);

    expect(emitted).toHaveLength(3); // start, delta, end
    expect(emitted[2].type).toBe("toolcall_end");
    expect(emitted[2].toolCall.arguments).toEqual({ path: "test.ts" });
  });

  it("handles finish event with usage and inputTokenDetails", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "finish",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: {
            cacheReadTokens: 30,
            cacheWriteTokens: 10,
          },
        },
        finishReason: "stop",
      },
      state,
    );
    expect(state.usage.input).toBe(100);
    expect(state.usage.output).toBe(50);
    expect(state.usage.cacheRead).toBe(30);
    expect(state.usage.cacheWrite).toBe(10);
    expect(state.usage.totalTokens).toBe(190);
    expect(state.stopReason).toBe("stop");
  });

  it("handles error event from CC API", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "error",
        error: { message: "Rate limit exceeded" },
      },
      state,
    );
    expect(state.streamError).toBe("Rate limit exceeded");
  });

  it("handles error event with string error", () => {
    const state = createStreamState();
    processStreamEvent({ type: "error", error: "Something went wrong" }, state);
    expect(state.streamError).toBe("Something went wrong");
  });
});

// ─── closeOpenBlocks ────────────────────────────────────────────────────

describe("closeOpenBlocks", () => {
  it("closes an open text block", () => {
    const state = createStreamState();
    state.content.push({ type: "text", text: "Hello" });
    state.currentTextIndex = 0;
    const emitted = closeOpenBlocks(state);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("text_end");
    expect(emitted[0].content).toBe("Hello");
    expect(state.currentTextIndex).toBe(-1);
  });

  it("flushes remaining thinking blocks", () => {
    const state = createStreamState();
    state.thinkingBlocks = ["hmm", "thinking"];
    const emitted = closeOpenBlocks(state);
    expect(emitted).toHaveLength(3); // thinking_start, delta, end
    expect(state.content.at(-1)).toEqual({ type: "thinking", thinking: "hmmthinking" });
  });
});

// ─── buildRequestBody ────────────────────────────────────────────────────

describe("buildRequestBody", () => {
  it("builds a valid request body with all required fields", () => {
    const body = buildRequestBody("deepseek/deepseek-v4-flash", [
      { role: "user", content: "Hello" },
    ]);
    expect(body.params.model).toBe("deepseek/deepseek-v4-flash");
    expect(body.params.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(body.params.stream).toBe(true);
    expect(body.config).toBeDefined();
    expect(body.threadId).toBeDefined();
    expect(body.params.system).toBe("");
    expect(body.skills).toBeNull();
    expect(body.permissionMode).toBe("standard");
  });

  it("caps max_tokens at 200,000", () => {
    const body = buildRequestBody("test-model", [], { maxTokens: 500_000 });
    expect(body.params.max_tokens).toBe(200_000);
  });

  it("includes tools when provided", () => {
    const tools = [{ type: "function", name: "bash", description: "Run cmd", input_schema: {} }];
    const body = buildRequestBody("test-model", [], { tools });
    expect(body.params.tools).toHaveLength(1);
  });

  it("passes empty tools array when no tools", () => {
    const body = buildRequestBody("test-model", []);
    expect(body.params.tools).toEqual([]);
  });

  it("includes system prompt when provided", () => {
    const body = buildRequestBody("test-model", [], {
      systemPrompt: "You are helpful.",
    });
    expect(body.params.system).toBe("You are helpful.");
  });
});

// ─── mapStopReason ──────────────────────────────────────────────────────────

describe("mapStopReason", () => {
  it.each([
    ["tool-calls", "toolUse"],
    ["tool_use", "toolUse"],
    ["tool_calls", "toolUse"],
    ["max_tokens", "length"],
    ["max-tokens", "length"],
    ["max_output_tokens", "length"],
    ["length", "length"],
    ["stop", "stop"],
    ["end_turn", "stop"],
  ] as const)("maps %s → %s", (input, expected) => {
    expect(mapStopReason(input)).toBe(expected);
  });
});

// ─── sanitizeApiKey ──────────────────────────────────────────────────────────

describe("sanitizeApiKey", () => {
  it("trims whitespace", () => {
    expect(sanitizeApiKey("  user_test  ")).toBe("user_test");
  });

  it("removes terminal paste wrappers", () => {
    const esc = String.fromCharCode(27);
    expect(sanitizeApiKey(`${esc}[200~user_test${esc}[201~`)).toBe("user_test");
  });

  it("removes control characters", () => {
    expect(sanitizeApiKey("user_\x00test")).toBe("user_test");
  });
});

// ─── abortError ──────────────────────────────────────────────────────────────

describe("abortError", () => {
  it("creates a DOMException with AbortError name", () => {
    const err = abortError();
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
  });
});

// ─── raceAbort ──────────────────────────────────────────────────────────────

describe("raceAbort", () => {
  it("resolves normally if signal is not aborted", async () => {
    const result = await raceAbort(Promise.resolve(42), new AbortController().signal);
    expect(result).toBe(42);
  });

  it("rejects with AbortError if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceAbort(Promise.resolve(42), controller.signal)).rejects.toThrow();
  });
});

// ─── Full Stream Simulation ─────────────────────────────────────────────────

describe("full stream simulation", () => {
  it("processes a complete text-only response", () => {
    const state = createStreamState();
    const events = [
      { type: "start" },
      { type: "start-step" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: "!" },
      {
        type: "finish",
        totalUsage: { inputTokens: 10, outputTokens: 2 },
        finishReason: "stop",
      },
    ];

    for (const event of events) {
      processStreamEvent(event, state);
    }

    expect(state.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(state.usage.input).toBe(10);
    expect(state.usage.output).toBe(2);
    expect(state.stopReason).toBe("stop");
  });

  it("processes a response with thinking + text + tool call (CC native format)", () => {
    const state = createStreamState();
    const events = [
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "Let me " },
      { type: "reasoning-delta", text: "think..." },
      { type: "reasoning-end" },
      { type: "text-delta", text: "I'll read that file." },
      {
        type: "tool-call",
        toolCallId: "tc_1",
        toolName: "read",
        input: { path: "test.ts" },
      },
      {
        type: "finish",
        totalUsage: { inputTokens: 100, outputTokens: 30 },
        finishReason: "tool-calls",
      },
    ];

    for (const event of events) {
      processStreamEvent(event, state);
    }

    expect(state.content).toHaveLength(3);
    expect(state.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." });
    expect(state.content[1]).toEqual({ type: "text", text: "I'll read that file." });
    expect(state.content[2]).toEqual({
      type: "toolCall",
      id: "tc_1",
      name: "read",
      arguments: { path: "test.ts" },
    });
    expect(state.stopReason).toBe("toolUse");
  });

  it("processes error stream event", () => {
    const state = createStreamState();
    processStreamEvent(
      { type: "error", error: { message: "Model overloaded" } },
      state,
    );
    expect(state.streamError).toBe("Model overloaded");
  });
});