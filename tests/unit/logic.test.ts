import { describe, it, expect } from "vitest";
import {
  resolveApiKey,
  convertMessages,
  convertTools,
  parseNDJSON,
  processStreamEvent,
  createStreamState,
  buildRequestBody,
  mapStopReason,
} from "../../src/logic.js";

// ─── resolveApiKey ──────────────────────────────────────────────────────────

describe("resolveApiKey", () => {
  it("returns provided key first", () => {
    expect(resolveApiKey("user_provided", "user_env", () => "", "/home")).toBe("user_provided");
  });

  it("falls back to env var", () => {
    expect(resolveApiKey(undefined, "user_env", () => "", "/home")).toBe("user_env");
  });

  it("falls back to auth.json", () => {
    const readFile = () => JSON.stringify({ apiKey: "user_from_file" });
    expect(resolveApiKey(undefined, undefined, readFile, "/home")).toBe("user_from_file");
  });

  it("throws when no key is available", () => {
    expect(() => resolveApiKey()).toThrow("No Command Code API key found");
  });

  it("throws when auth.json is missing", () => {
    const readFile = () => {
      throw new Error("ENOENT");
    };
    expect(() => resolveApiKey(undefined, undefined, readFile, "/home")).toThrow(
      "No Command Code API key found",
    );
  });

  it("throws when auth.json has no apiKey field", () => {
    const readFile = () => JSON.stringify({});
    expect(() => resolveApiKey(undefined, undefined, readFile, "/home")).toThrow(
      "No Command Code API key found",
    );
  });
});

// ─── convertMessages ────────────────────────────────────────────────────────

describe("convertMessages", () => {
  it("converts a simple user string message", () => {
    const result = convertMessages([
      { role: "user", content: "Hello" },
    ]);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts user content array to text", () => {
    const result = convertMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: "Line 1\nLine 2" }]);
  });

  it("converts assistant message with text only", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    ]);
    expect(result).toEqual([{ role: "assistant", content: "Hello!" }]);
  });

  it("converts assistant message with tool calls", () => {
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
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: "Let me check",
        tool_calls: [
          {
            type: "function",
            id: "call_123",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ]);
  });

  it("converts assistant with only tool calls (no text)", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_456",
            name: "read",
            arguments: { path: "/tmp/test.txt" },
          },
        ],
      },
    ]);
    expect(result[0].content).toBeNull();
    expect(result[0].tool_calls).toHaveLength(1);
  });

  it("converts toolResult message", () => {
    const result = convertMessages([
      {
        role: "toolResult",
        toolCallId: "call_123",
        content: "file contents here",
      },
    ]);
    expect(result).toEqual([
      { role: "tool", tool_call_id: "call_123", content: "file contents here" },
    ]);
  });

  it("converts toolResult with content array", () => {
    const result = convertMessages([
      {
        role: "toolResult",
        toolCallId: "call_789",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: "tool", tool_call_id: "call_789", content: "Part 1\nPart 2" },
    ]);
  });

  it("handles empty content array in toolResult", () => {
    const result = convertMessages([
      {
        role: "toolResult",
        toolCallId: "call_empty",
        content: [],
      },
    ]);
    expect(result[0].content).toBe("");
  });

  it("skips whitespace-only text in assistant messages", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      },
    ]);
    expect(result[0].content).toBeNull();
  });

  it("handles a full conversation", () => {
    const result = convertMessages([
      { role: "user", content: "Read test.txt" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "test.txt" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: "file content",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here's the file content" }],
      },
    ]);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("tool");
    expect(result[3].role).toBe("assistant");
  });
});

// ─── convertTools ───────────────────────────────────────────────────────────

describe("convertTools", () => {
  it("converts tools to OpenAI function format", () => {
    const result = convertTools([
      {
        name: "bash",
        description: "Execute a bash command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ]);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "bash",
          description: "Execute a bash command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ]);
  });

  it("handles tools without description", () => {
    const result = convertTools([{ name: "my_tool" }]);
    expect(result[0].function.description).toBe("");
  });

  it("handles tools without parameters", () => {
    const result = convertTools([{ name: "noop" }]);
    expect(result[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("returns empty array for empty input", () => {
    expect(convertTools([])).toEqual([]);
  });
});

// ─── parseNDJSON ────────────────────────────────────────────────────────────

describe("parseNDJSON", () => {
  it("parses simple NDJSON lines", () => {
    const raw = '{"type":"start"}\n{"type":"text-delta","text":"Hi"}\n';
    const result = parseNDJSON(raw);
    expect(result).toEqual([
      { type: "start" },
      { type: "text-delta", text: "Hi" },
    ]);
  });

  it("handles SSE-style data: prefix", () => {
    const raw = 'data: {"type":"start"}\ndata: {"type":"text-delta","text":"Hi"}\n\n';
    const result = parseNDJSON(raw);
    expect(result).toEqual([
      { type: "start" },
      { type: "text-delta", text: "Hi" },
    ]);
  });

  it("handles mixed NDJSON and SSE lines", () => {
    const raw = '{"type":"start"}\ndata: {"type":"text-delta","text":"Hi"}\n';
    const result = parseNDJSON(raw);
    expect(result).toHaveLength(2);
  });

  it("stops at [DONE]", () => {
    const raw = '{"type":"start"}\n[DONE]\n{"type":"after"}\n';
    const result = parseNDJSON(raw);
    expect(result).toEqual([{ type: "start" }]);
  });

  it("skips empty lines and comments", () => {
    const raw = '\n{"type":"start"}\n\n: keep-alive\n{"type":"finish"}\n';
    const result = parseNDJSON(raw);
    expect(result).toHaveLength(2);
  });

  it("skips unparseable lines", () => {
    const raw = '{"type":"start"}\nnot json\n{"type":"finish"}\n';
    const result = parseNDJSON(raw);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty string", () => {
    expect(parseNDJSON("")).toEqual([]);
  });
});

// ─── processStreamEvent ────────────────────────────────────────────────────

describe("processStreamEvent", () => {
  it("handles text-start → text-delta → text-end sequence", () => {
    const state = createStreamState();

    processStreamEvent({ type: "text-start" }, state);
    expect(state.currentTextIndex).toBe(0);
    expect(state.content).toHaveLength(1);
    expect(state.content[0]).toEqual({ type: "text", text: "" });

    processStreamEvent({ type: "text-delta", text: "Hello " }, state);
    expect(state.content[0]).toEqual({ type: "text", text: "Hello " });

    processStreamEvent({ type: "text-delta", text: "World" }, state);
    expect(state.content[0]).toEqual({ type: "text", text: "Hello World" });

    const emitted = processStreamEvent({ type: "text-end" }, state);
    expect(emitted).toEqual([
      { type: "text_end", contentIndex: 0, content: "Hello World" },
    ]);
    expect(state.currentTextIndex).toBe(-1);
  });

  it("handles text-delta without text-start (auto-creates block)", () => {
    const state = createStreamState();
    const emitted = processStreamEvent({ type: "text-delta", text: "Hi" }, state);
    expect(emitted[0].type).toBe("text_start");
    expect(emitted[1].type).toBe("text_delta");
    expect(state.content[0].text).toBe("Hi");
  });

  it("handles tool-call-start/delta/end sequence", () => {
    const state = createStreamState();

    processStreamEvent(
      { type: "tool-call-start", id: "tc_1", name: "bash" },
      state,
    );
    expect(state.currentToolId).toBe("tc_1");
    expect(state.currentToolName).toBe("bash");

    processStreamEvent(
      { type: "tool-call-delta", delta: '{"command":' },
      state,
    );
    processStreamEvent(
      { type: "tool-call-delta", delta: '"ls"}' },
      state,
    );
    expect(state.partialToolJson).toBe('{"command":"ls"}');

    const emitted = processStreamEvent({ type: "tool-call-end" }, state);
    expect(emitted).toHaveLength(3); // start, delta, end
    expect(emitted[2].type).toBe("toolcall_end");
    expect(emitted[2].toolCall).toEqual({
      type: "toolCall",
      id: "tc_1",
      name: "bash",
      arguments: { command: "ls" },
    });
  });

  it("handles tool_call_start/delta/end with underscores", () => {
    const state = createStreamState();
    processStreamEvent(
      { type: "tool_call_start", id: "tc_2", name: "read" },
      state,
    );
    processStreamEvent(
      { type: "tool_call_delta", arguments: '{"path":"test.ts"}' },
      state,
    );
    const emitted = processStreamEvent({ type: "tool_call_end" }, state);
    expect(emitted[2].toolCall.arguments).toEqual({ path: "test.ts" });
  });

  it("handles tool call with unparseable JSON arguments", () => {
    const state = createStreamState();
    processStreamEvent(
      { type: "tool-call-start", id: "tc_3", name: "edit" },
      state,
    );
    processStreamEvent(
      { type: "tool-call-delta", delta: "not valid json" },
      state,
    );
    const emitted = processStreamEvent({ type: "tool-call-end" }, state);
    expect(emitted[2].toolCall.arguments).toEqual({}); // fallback to empty
  });

  it("handles finish event with usage", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "finish",
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: "stop",
      },
      state,
    );
    expect(state.usage.input).toBe(100);
    expect(state.usage.output).toBe(50);
    expect(state.usage.totalTokens).toBe(150);
    expect(state.stopReason).toBe("stop");
  });

  it("handles finish with cache tokens", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "finish",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 30,
          cacheWriteTokens: 10,
        },
      },
      state,
    );
    expect(state.usage.cacheRead).toBe(30);
    expect(state.usage.cacheWrite).toBe(10);
    expect(state.usage.totalTokens).toBe(190);
  });

  it("maps finishReason tool_use → toolUse", () => {
    const state = createStreamState();
    processStreamEvent({ type: "finish", finishReason: "tool_use" }, state);
    expect(state.stopReason).toBe("toolUse");
  });

  it("maps finishReason tool_calls → toolUse", () => {
    const state = createStreamState();
    processStreamEvent({ type: "finish", finishReason: "tool_calls" }, state);
    expect(state.stopReason).toBe("toolUse");
  });

  it("maps finishReason max_tokens → length", () => {
    const state = createStreamState();
    processStreamEvent({ type: "finish", finishReason: "max_tokens" }, state);
    expect(state.stopReason).toBe("length");
  });

  it("maps finishReason length → length", () => {
    const state = createStreamState();
    processStreamEvent({ type: "finish", finishReason: "length" }, state);
    expect(state.stopReason).toBe("length");
  });

  it("maps unknown finishReason → stop", () => {
    const state = createStreamState();
    processStreamEvent({ type: "finish", finishReason: "end_turn" }, state);
    expect(state.stopReason).toBe("stop");
  });

  it("handles totalUsage alias for usage", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "finish",
        totalUsage: { inputTokens: 200, outputTokens: 100 },
      },
      state,
    );
    expect(state.usage.input).toBe(200);
    expect(state.usage.output).toBe(100);
  });

  it("ignores reasoning events", () => {
    const state = createStreamState();
    const e1 = processStreamEvent({ type: "reasoning-start" }, state);
    const e2 = processStreamEvent({ type: "reasoning-delta", text: "hmm" }, state);
    const e3 = processStreamEvent({ type: "reasoning-end" }, state);
    expect(e1).toEqual([]);
    expect(e2).toEqual([]);
    expect(e3).toEqual([]);
  });

  it("ignores unknown event types", () => {
    const state = createStreamState();
    const emitted = processStreamEvent({ type: "start" }, state);
    expect(emitted).toEqual([]);
  });

  it("handles multiple text blocks (text resets textIndex)", () => {
    const state = createStreamState();

    processStreamEvent({ type: "text-start" }, state);
    processStreamEvent({ type: "text-delta", text: "Block 1" }, state);
    processStreamEvent({ type: "text-end" }, state);

    processStreamEvent({ type: "text-start" }, state);
    processStreamEvent({ type: "text-delta", text: "Block 2" }, state);
    processStreamEvent({ type: "text-end" }, state);

    expect(state.content).toHaveLength(2);
    expect(state.content[0].text).toBe("Block 1");
    expect(state.content[1].text).toBe("Block 2");
  });

  it("handles finish-step (not just finish)", () => {
    const state = createStreamState();
    processStreamEvent(
      {
        type: "finish-step",
        usage: { inputTokens: 50, outputTokens: 25 },
        finishReason: "stop",
      },
      state,
    );
    expect(state.usage.input).toBe(50);
    expect(state.stopReason).toBe("stop");
  });
});

// ─── buildRequestBody ───────────────────────────────────────────────────────

describe("buildRequestBody", () => {
  it("builds a valid request body", () => {
    const body = buildRequestBody("deepseek/deepseek-v4-flash", [
      { role: "user", content: "Hello" },
    ]);
    expect(body.params.model).toBe("deepseek/deepseek-v4-flash");
    expect(body.params.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(body.params.stream).toBe(true);
    expect(body.params.max_tokens).toBe(16384);
    expect(body.config).toBeDefined();
    expect(body.threadId).toBeDefined();
  });

  it("includes tools when provided", () => {
    const body = buildRequestBody("test-model", [], {
      tools: [{ type: "function", function: { name: "bash" } }],
    });
    expect(body.params.tools).toHaveLength(1);
  });

  it("omits tools when not provided", () => {
    const body = buildRequestBody("test-model", []);
    expect(body.params.tools).toBeUndefined();
  });

  it("includes system prompt when provided", () => {
    const body = buildRequestBody("test-model", [], {
      systemPrompt: "You are a helpful assistant.",
    });
    expect(body.params.system).toBe("You are a helpful assistant.");
  });

  it("omits system prompt when not provided", () => {
    const body = buildRequestBody("test-model", []);
    expect(body.params.system).toBeUndefined();
  });

  it("respects maxTokens override", () => {
    const body = buildRequestBody("test-model", [], { maxTokens: 4096 });
    expect(body.params.max_tokens).toBe(4096);
  });

  it("defaults to 16384 max tokens", () => {
    const body = buildRequestBody("test-model", []);
    expect(body.params.max_tokens).toBe(16384);
  });
});

// ─── mapStopReason ──────────────────────────────────────────────────────────

describe("mapStopReason", () => {
  it.each([
    ["tool_use", "toolUse"],
    ["tool_calls", "toolUse"],
    ["max_tokens", "length"],
    ["length", "length"],
    ["stop", "stop"],
    ["end_turn", "stop"],
    ["complete", "stop"],
  ] as const)("maps %s → %s", (input, expected) => {
    expect(mapStopReason(input)).toBe(expected);
  });
});

// ─── createStreamState ──────────────────────────────────────────────────────

describe("createStreamState", () => {
  it("creates state with correct defaults", () => {
    const state = createStreamState();
    expect(state.content).toEqual([]);
    expect(state.currentTextIndex).toBe(-1);
    expect(state.stopReason).toBe("stop");
    expect(state.partialToolJson).toBe("");
    expect(state.events).toEqual([]);
    expect(state.usage.input).toBe(0);
    expect(state.usage.output).toBe(0);
    expect(state.usage.totalTokens).toBe(0);
  });
});

// ─── Full Stream Simulation ─────────────────────────────────────────────────

describe("full stream simulation", () => {
  it("processes a complete text-only response", () => {
    const state = createStreamState();
    const events = [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: "!" },
      { type: "text-end" },
      {
        type: "finish",
        usage: { inputTokens: 10, outputTokens: 2 },
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

  it("processes a response with tool calls", () => {
    const state = createStreamState();
    const events = [
      { type: "text-start" },
      { type: "text-delta", text: "Let me read that file." },
      { type: "text-end" },
      { type: "tool-call-start", id: "tc_1", name: "read" },
      { type: "tool-call-delta", delta: '{"path":"test.ts"}' },
      { type: "tool-call-end" },
      {
        type: "finish",
        usage: { inputTokens: 50, outputTokens: 20 },
        finishReason: "tool_use",
      },
    ];

    for (const event of events) {
      processStreamEvent(event, state);
    }

    expect(state.content).toHaveLength(2);
    expect(state.content[0]).toEqual({ type: "text", text: "Let me read that file." });
    expect(state.content[1].type).toBe("toolCall");
    expect(state.content[1].name).toBe("read");
    expect(state.content[1].arguments).toEqual({ path: "test.ts" });
    expect(state.stopReason).toBe("toolUse");
  });

  it("handles multiple text blocks separated by tool calls", () => {
    const state = createStreamState();

    // Text block 1
    processStreamEvent({ type: "text-start" }, state);
    processStreamEvent({ type: "text-delta", text: "First " }, state);
    processStreamEvent({ type: "text-delta", text: "block" }, state);
    processStreamEvent({ type: "text-end" }, state);

    // Tool call
    processStreamEvent({ type: "tool-call-start", id: "tc_1", name: "bash" }, state);
    processStreamEvent({ type: "tool-call-delta", delta: '{"command":"ls"}' }, state);
    processStreamEvent({ type: "tool-call-end" }, state);

    // Text block 2
    processStreamEvent({ type: "text-start" }, state);
    processStreamEvent({ type: "text-delta", text: "Second block" }, state);
    processStreamEvent({ type: "text-end" }, state);

    expect(state.content).toHaveLength(3);
    expect(state.content[0].text).toBe("First block");
    expect(state.content[1].name).toBe("bash");
    expect(state.content[2].text).toBe("Second block");
  });
});
