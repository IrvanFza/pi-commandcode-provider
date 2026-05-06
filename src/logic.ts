/**
 * Pure logic for Command Code provider — testable without pi runtime.
 *
 * Handles message conversion, tool conversion, and NDJSON stream parsing.
 * @module commandcode-logic
 */

// Types used from pi-ai (re-declared here to avoid import at test time)
// These are type-only and erased at runtime, but the import resolution
// can fail in isolated test environments.
type TextContent = { type: "text"; text: string };
type Tool = {
  name: string;
  description?: string;
  parameters?: any;
};
type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: any;
};

// ─── API Key Resolution ────────────────────────────────────────────────────

/**
 * Resolve the Command Code API key.
 * Priority: provided key → COMMANDCODE_API_KEY env var → ~/.commandcode/auth.json
 */
export function resolveApiKey(
  providedKey?: string,
  envVar?: string,
  readFile?: (path: string) => string,
  homeDir?: string,
): string {
  if (providedKey) return providedKey;
  if (envVar) return envVar;

  if (readFile && homeDir) {
    try {
      const auth = JSON.parse(readFile(`${homeDir}/.commandcode/auth.json`));
      if (auth.apiKey) return auth.apiKey;
    } catch {
      // ignore read errors
    }
  }

  throw new Error(
    "No Command Code API key found. Set COMMANDCODE_API_KEY or run `cmd login`.",
  );
}

// ─── Message Conversion (pi → CC OpenAI-compatible format) ─────────────────

export function convertMessages(messages: any[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const text = msg.content
          .filter((c: any): c is TextContent => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (text) result.push({ role: "user", content: text });
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          toolCalls.push({
            type: "function",
            id: block.id,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            },
          });
        }
      }
      const assistant: any = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      result.push(assistant);
    } else if (msg.role === "toolResult") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c: any): c is TextContent => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
      result.push({
        role: "tool",
        tool_call_id: (msg as any).toolCallId,
        content: content || "",
      });
    }
  }
  return result;
}

export function convertTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  }));
}

// ─── NDJSON Stream Parsing ─────────────────────────────────────────────────

export interface StreamState {
  content: any[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  currentTextIndex: number;
  partialToolJson: string;
  currentToolId: string;
  currentToolName: string;
  events: any[];  // collected stream events for assertions
}

export function createStreamState(): StreamState {
  return {
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    currentTextIndex: -1,
    partialToolJson: "",
    currentToolId: "",
    currentToolName: "",
    events: [],
  };
}

/**
 * Process a single NDJSON event from the Command Code stream.
 * Mutates state in place and returns emitted pi stream events.
 */
export function processStreamEvent(event: any, state: StreamState): any[] {
  const emitted: any[] = [];
  const t = event.type;

  // ── Text events ──
  if (t === "text-start") {
    if (state.currentTextIndex < 0) {
      state.content.push({ type: "text", text: "" });
      state.currentTextIndex = state.content.length - 1;
      emitted.push({ type: "text_start", contentIndex: state.currentTextIndex });
    }
  } else if (t === "text-delta") {
    if (state.currentTextIndex < 0) {
      state.content.push({ type: "text", text: "" });
      state.currentTextIndex = state.content.length - 1;
      emitted.push({ type: "text_start", contentIndex: state.currentTextIndex });
    }
    const delta = event.text || "";
    const block = state.content[state.currentTextIndex] as any;
    block.text += delta;
    emitted.push({ type: "text_delta", contentIndex: state.currentTextIndex, delta });
  } else if (t === "text-end") {
    if (state.currentTextIndex >= 0) {
      const block = state.content[state.currentTextIndex] as any;
      emitted.push({ type: "text_end", contentIndex: state.currentTextIndex, content: block.text });
      state.currentTextIndex = -1;
    }

    // ── Reasoning events (ignored) ──
  } else if (t === "reasoning-start" || t === "reasoning-delta" || t === "reasoning-end") {
    // skip

    // ── Tool call events ──
  } else if (t === "tool-call-start" || t === "tool_call_start") {
    state.partialToolJson = "";
    state.currentToolId = event.id || "";
    state.currentToolName = event.name || "";
  } else if (t === "tool-call-delta" || t === "tool_call_delta") {
    state.partialToolJson += event.delta || event.arguments || "";
  } else if (t === "tool-call-end" || t === "tool_call_end") {
    let args: any = {};
    try {
      args = JSON.parse(state.partialToolJson);
    } catch {
      // use empty args on parse failure
    }
    const toolCall: ToolCall = {
      type: "toolCall",
      id: event.id || state.currentToolId,
      name: event.name || state.currentToolName,
      arguments: args,
    };
    state.content.push(toolCall);
    const ci = state.content.length - 1;
    emitted.push({ type: "toolcall_start", contentIndex: ci });
    emitted.push({ type: "toolcall_delta", contentIndex: ci, delta: state.partialToolJson });
    emitted.push({ type: "toolcall_end", contentIndex: ci, toolCall });
    state.partialToolJson = "";

    // ── Finish events ──
  } else if (t === "finish-step" || t === "finish") {
    const usage = event.usage || event.totalUsage;
    if (usage) {
      state.usage.input = usage.inputTokens || state.usage.input;
      state.usage.output = usage.outputTokens || state.usage.output;
      state.usage.cacheRead =
        usage.cachedInputTokens || usage.cacheReadTokens || state.usage.cacheRead;
      state.usage.cacheWrite = usage.cacheWriteTokens || state.usage.cacheWrite;
      state.usage.totalTokens =
        state.usage.input + state.usage.output + state.usage.cacheRead + state.usage.cacheWrite;
    }
    if (event.finishReason) {
      const r = event.finishReason;
      state.stopReason =
        r === "tool_use" || r === "tool_calls"
          ? "toolUse"
          : r === "max_tokens" || r === "length"
            ? "length"
            : "stop";
    }
  }

  state.events.push(...emitted);
  return emitted;
}

/**
 * Parse a raw NDJSON string into an array of JSON objects.
 * Handles both raw NDJSON and SSE "data: " prefixed lines.
 */
export function parseNDJSON(raw: string): any[] {
  const results: any[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
    if (jsonStr === "[DONE]") break;
    try {
      results.push(JSON.parse(jsonStr));
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}

/**
 * Build the request body for Command Code's /alpha/generate endpoint.
 */
export function buildRequestBody(
  model: string,
  messages: any[],
  options?: {
    tools?: any[];
    systemPrompt?: string;
    maxTokens?: number;
    workingDir?: string;
  },
): any {
  const body: any = {
    config: {
      workingDir: options?.workingDir || process.cwd(),
      date: new Date().toISOString().split("T")[0],
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: "",
    skills: "",
    params: {
      messages,
      model,
      max_tokens: options?.maxTokens || 16384,
      stream: true,
    },
    threadId: crypto.randomUUID(),
  };

  if (options?.tools && options.tools.length > 0) body.params.tools = options.tools;
  if (options?.systemPrompt) body.params.system = options.systemPrompt;

  return body;
}

/**
 * Map a Command Code finish reason to pi's stop reason.
 */
export function mapStopReason(reason: string): "stop" | "length" | "toolUse" {
  if (reason === "tool_use" || reason === "tool_calls") return "toolUse";
  if (reason === "max_tokens" || reason === "length") return "length";
  return "stop";
}
