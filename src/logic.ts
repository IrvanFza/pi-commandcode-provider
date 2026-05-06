/**
 * Pure logic for Command Code provider — testable without pi runtime.
 *
 * Handles message conversion, tool conversion, stream event parsing,
 * and authentication for Command Code's /alpha/generate API.
 * @module commandcode-logic
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Type helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {};
}

// ─── API Key Resolution ────────────────────────────────────────────────────

export function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
  ];
}

export interface AuthKeyOptions {
  env?: Record<string, string | undefined>;
  authPaths?: readonly string[];
  homeDir?: () => string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

/**
 * Resolve the Command Code API key.
 * Priority: provided key → COMMANDCODE_API_KEY env var → auth files
 *
 * Auth files can contain:
 * - {"apiKey": "user_..."}        (Command Code CLI)
 * - {"commandcode": "user_..."}   (alternative format)
 * - {"commandcode": {"type":"oauth","access":"user_..."}}  (pi OAuth)
 */
export function resolveApiKey(
  providedKey?: string,
  options: AuthKeyOptions = {},
): string | undefined {
  if (providedKey) return providedKey;

  const env = options.env ?? process.env;
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY;

  const home = options.homeDir?.() ?? homedir();
  const authPaths = options.authPaths ?? defaultAuthPaths(home);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const fileExists = options.fileExists ?? ((p: string) => existsSync(p));

  for (const authPath of authPaths) {
    try {
      if (!fileExists(authPath)) continue;
      const parsed: unknown = JSON.parse(readFile(authPath));
      if (!isRecord(parsed)) continue;

      // Direct apiKey field
      const apiKey = stringValue(parsed.apiKey);
      if (apiKey) return apiKey;

      // commandcode field (string or OAuth object)
      const ccField = parsed.commandcode;
      if (typeof ccField === "string") return ccField;
      if (isRecord(ccField)) {
        // OAuth credentials: {"type":"oauth","access":"user_..."}
        const access = stringValue(ccField.access);
        if (access) return access;
      }
    } catch {
      // ignore malformed or unreadable auth files
    }
  }

  return undefined;
}

// ─── Message Conversion (pi → CC native format) ────────────────────────────

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function textContent(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n");
}

/**
 * Find tool call IDs that have matching tool results.
 * CC's API requires paired tool-call + tool-result.
 */
function completeToolCallIds(messages?: readonly any[]): Set<string> {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "toolCall") {
          const id = stringValue(content.id);
          if (id) callIds.add(id);
        }
      }
    } else if (message.role === "toolResult") {
      if (message.toolCallId) resultIds.add(message.toolCallId);
    }
  }

  return new Set([...callIds].filter((id) => resultIds.has(id)));
}

/**
 * Convert pi messages to Command Code's native message format.
 *
 * CC uses structured content arrays:
 * - assistant: [{type:"text"}, {type:"reasoning"}, {type:"tool-call"}]
 * - tool: [{type:"tool-result"}]
 * NOT OpenAI's flat text + tool_calls format.
 */
export function convertMessages(messages: any[]): any[] {
  const out: any[] = [];
  const pairedToolCallIds = completeToolCallIds(messages);

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : msg.content,
      });
    } else if (msg.role === "assistant") {
      const parts: any[] = [];
      for (const content of recordArray(msg.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" });
        } else if (content.type === "thinking") {
          parts.push({
            type: "reasoning",
            text: stringValue(content.thinking) ?? "",
          });
        } else if (content.type === "toolCall") {
          const toolCallId = stringValue(content.id) ?? "";
          if (!pairedToolCallIds.has(toolCallId)) continue;
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName: stringValue(content.name) ?? "",
            input: recordOrEmpty(content.arguments),
          });
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
    } else if (msg.role === "toolResult") {
      if (!msg.toolCallId || !pairedToolCallIds.has(msg.toolCallId)) continue;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            output: msg.isError
              ? { type: "error-text", value: textContent(msg) }
              : { type: "text", value: textContent(msg) },
          },
        ],
      });
    }
  }
  return out;
}

// ─── Tool Conversion (pi → CC native format with input_schema) ─────────────

/**
 * Convert pi's Typebox tool schemas to JSON Schema for CC's input_schema field.
 */
function toJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return {};

  const kind = stringValue(schema.kind) ?? stringValue(schema.type);
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues) {
    return { type: typeof enumValues[0], enum: enumValues };
  }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" };
    case "number":
    case "Number":
      return { type: "number" };
    case "boolean":
    case "Boolean":
      return { type: "boolean" };
    case "object":
    case "Object": {
      const properties: Record<string, unknown> = {};
      const inferredRequired: string[] = [];
      const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined;
      const optional = Array.isArray(schema.optional)
        ? schema.optional.filter((item): item is string => typeof item === "string")
        : [];

      if (sourceProperties) {
        for (const [key, value] of Object.entries(sourceProperties)) {
          properties[key] = toJsonSchema(value);
          const valueRecord = isRecord(value) ? value : undefined;
          if (
            valueRecord?.optional !== true &&
            !optional.includes(key)
          ) {
            inferredRequired.push(key);
          }
        }
      }

      const explicitRequired = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : undefined;
      const required = explicitRequired ?? inferredRequired;
      const out: Record<string, unknown> = { type: "object" };
      if (Object.keys(properties).length > 0) out.properties = properties;
      if (required.length > 0) out.required = required;
      return out;
    }
    case "array":
    case "Array":
      return {
        type: "array",
        items: toJsonSchema(schema.items ?? schema.element),
      };
    case "union":
    case "Union": {
      const variants = Array.isArray(schema.variants)
        ? schema.variants
        : Array.isArray(schema.anyOf)
          ? schema.anyOf
          : [];
      for (const variant of variants) {
        const converted = toJsonSchema(variant);
        if (isRecord(converted) && Object.keys(converted).length > 0) return converted;
      }
      return {};
    }
    case "optional":
    case "Optional":
      return toJsonSchema(schema.wrapped ?? schema.inner);
    default:
      return {};
  }
}

/**
 * Convert pi tools to CC native format.
 * CC uses: {type:"function", name, description, input_schema}
 * NOT OpenAI's: {type:"function", function: {name, description, parameters}}
 */
export function convertTools(tools: any[]): any[] {
  if (!tools) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
  }));
}

// ─── NDJSON Stream Parsing ─────────────────────────────────────────────────

/**
 * Parse a single NDJSON line. Handles both raw NDJSON and SSE "data: " prefix.
 */
export function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Parse a raw NDJSON string into an array of JSON objects.
 */
export function parseNDJSON(raw: string): any[] {
  const results: any[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const event = parseStreamEventLine(line);
    if (event !== undefined) results.push(event);
  }
  return results;
}

// ─── Stream State ──────────────────────────────────────────────────────────

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
  currentThinkingIndex: number;
  thinkingBlocks: string[];
  partialToolJson: string;
  currentToolId: string;
  currentToolName: string;
  events: any[];
  finished: boolean;
  streamError: string | undefined;
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
    currentThinkingIndex: -1,
    thinkingBlocks: [],
    partialToolJson: "",
    currentToolId: "",
    currentToolName: "",
    events: [],
    finished: false,
    streamError: undefined,
  };
}

// ─── Stream Event Processing ────────────────────────────────────────────────

/**
 * Process a single NDJSON event from the Command Code stream.
 * Mutates state in place and returns emitted pi stream events.
 *
 * CC event types:
 * - text-delta: stream text tokens
 * - reasoning-delta: reasoning/thinking tokens
 * - reasoning-end: flush thinking block
 * - tool-call: tool call complete
 * - finish: stream complete with usage
 * - error: API error
 */
export function processStreamEvent(event: any, state: StreamState): any[] {
  const emitted: any[] = [];
  const t = event.type;

  // ── Text events ──
  if (t === "text-delta") {
    if (state.currentTextIndex < 0) {
      state.content.push({ type: "text", text: "" });
      state.currentTextIndex = state.content.length - 1;
      emitted.push({ type: "text_start", contentIndex: state.currentTextIndex });
    }
    const delta = stringValue(event.text) ?? "";
    const block = state.content[state.currentTextIndex] as any;
    block.text += delta;
    emitted.push({ type: "text_delta", contentIndex: state.currentTextIndex, delta });
    // ── Reasoning/thinking events ──
  } else if (t === "reasoning-delta") {
    state.thinkingBlocks.push(stringValue(event.text) ?? "");
    // ── Reasoning end: flush thinking block ──
  } else if (t === "reasoning-end") {
    if (state.thinkingBlocks.length > 0) {
      const thinkingText = state.thinkingBlocks.join("");
      state.thinkingBlocks = [];
      state.content.push({ type: "thinking", thinking: thinkingText });
      state.currentThinkingIndex = state.content.length - 1;
      emitted.push({
        type: "thinking_start",
        contentIndex: state.currentThinkingIndex,
      });
      emitted.push({
        type: "thinking_delta",
        contentIndex: state.currentThinkingIndex,
        delta: thinkingText,
      });
      emitted.push({
        type: "thinking_end",
        contentIndex: state.currentThinkingIndex,
        content: thinkingText,
      });
      state.currentThinkingIndex = -1;
    }

    // ── Tool call events (CC native format: single tool-call event with all data) ──
  } else if (t === "tool-call") {
    // Close any open text block first
    if (state.currentTextIndex >= 0) {
      const block = state.content[state.currentTextIndex] as any;
      emitted.push({
        type: "text_end",
        contentIndex: state.currentTextIndex,
        content: block.text,
      });
      state.currentTextIndex = -1;
    }

    const toolCall = {
      type: "toolCall" as const,
      id: stringValue(event.toolCallId) ?? "",
      name: stringValue(event.toolName) ?? "",
      arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
    };
    state.content.push(toolCall);
    const ci = state.content.length - 1;
    emitted.push({ type: "toolcall_start", contentIndex: ci });
    emitted.push({ type: "toolcall_end", contentIndex: ci, toolCall });

    // ── Finish events ──
  } else if (t === "finish") {
    const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
    if (usage) {
      const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
      state.usage.input = numberValue(usage.inputTokens) ?? state.usage.input;
      state.usage.output = numberValue(usage.outputTokens) ?? state.usage.output;
      state.usage.cacheRead = numberValue(details?.cacheReadTokens) ?? state.usage.cacheRead;
      state.usage.cacheWrite = numberValue(details?.cacheWriteTokens) ?? state.usage.cacheWrite;
      state.usage.totalTokens =
        state.usage.input +
        state.usage.output +
        state.usage.cacheRead +
        state.usage.cacheWrite;
    }
    state.stopReason = mapStopReason(event.finishReason);
    state.finished = true;

    // ── Error events ──
  } else if (t === "error") {
    const errorRecord = isRecord(event.error) ? event.error : undefined;
    state.streamError =
      stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error";
  }

  // start / start-step / text-start / text-end / tool-call-start/delta/end
  // are alternative event types that some CC models may send.
  // Handle the CC custom format as well.
  else if (t === "text-start") {
    if (state.currentTextIndex < 0) {
      state.content.push({ type: "text", text: "" });
      state.currentTextIndex = state.content.length - 1;
      emitted.push({ type: "text_start", contentIndex: state.currentTextIndex });
    }
  } else if (t === "text-end") {
    if (state.currentTextIndex >= 0) {
      const block = state.content[state.currentTextIndex] as any;
      emitted.push({
        type: "text_end",
        contentIndex: state.currentTextIndex,
        content: block.text,
      });
      state.currentTextIndex = -1;
    }
  } else if (t === "tool-call-start" || t === "tool_call_start") {
    // Alternative: incremental tool call streaming
    state.partialToolJson = "";
    state.currentToolId = stringValue(event.id) ?? stringValue(event.toolCallId) ?? "";
    state.currentToolName = stringValue(event.name) ?? stringValue(event.toolName) ?? "";
  } else if (t === "tool-call-delta" || t === "tool_call_delta") {
    state.partialToolJson += stringValue(event.delta) ?? stringValue(event.arguments) ?? "";
  } else if (t === "tool-call-end" || t === "tool_call_end") {
    const finalId =
      stringValue(event.id) ?? stringValue(event.toolCallId) ?? state.currentToolId;
    const finalName =
      stringValue(event.name) ?? stringValue(event.toolName) ?? state.currentToolName;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(state.partialToolJson);
    } catch {
      // use empty args on parse failure
    }

    // Close any open text block first
    if (state.currentTextIndex >= 0) {
      const block = state.content[state.currentTextIndex] as any;
      emitted.push({
        type: "text_end",
        contentIndex: state.currentTextIndex,
        content: block.text,
      });
      state.currentTextIndex = -1;
    }

    const toolCall = {
      type: "toolCall" as const,
      id: finalId,
      name: finalName,
      arguments: args,
    };
    state.content.push(toolCall);
    const ci = state.content.length - 1;
    emitted.push({ type: "toolcall_start", contentIndex: ci });
    emitted.push({ type: "toolcall_delta", contentIndex: ci, delta: state.partialToolJson });
    emitted.push({ type: "toolcall_end", contentIndex: ci, toolCall });
    state.partialToolJson = "";
  } else if (t === "finish-step") {
    // Some models send finish-step before finish
    const usage = isRecord(event.usage) || isRecord(event.totalUsage)
      ? (isRecord(event.totalUsage) ? event.totalUsage : event.usage)
      : undefined;
    if (usage) {
      const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
      state.usage.input = numberValue(usage.inputTokens) ?? state.usage.input;
      state.usage.output = numberValue(usage.outputTokens) ?? state.usage.output;
      state.usage.cacheRead = numberValue(details?.cacheReadTokens) ?? state.usage.cacheRead;
      state.usage.cacheWrite = numberValue(details?.cacheWriteTokens) ?? state.usage.cacheWrite;
      state.usage.totalTokens =
        state.usage.input +
        state.usage.output +
        state.usage.cacheRead +
        state.usage.cacheWrite;
    }
    if (event.finishReason) {
      state.stopReason = mapStopReason(event.finishReason);
    }
  }
  // reasoning-start — just a marker, no action needed
  else if (t === "reasoning-start") {
    // reset thinking blocks for a new reasoning sequence
    state.thinkingBlocks = [];
  }

  state.events.push(...emitted);
  return emitted;
}

/**
 * Close any open text block (call at end of stream).
 */
export function closeOpenBlocks(state: StreamState): any[] {
  const emitted: any[] = [];

  if (state.currentTextIndex >= 0) {
    const block = state.content[state.currentTextIndex] as any;
    emitted.push({
      type: "text_end",
      contentIndex: state.currentTextIndex,
      content: block.text,
    });
    state.currentTextIndex = -1;
  }

  // Flush any remaining thinking blocks
  if (state.thinkingBlocks.length > 0) {
    const thinkingText = state.thinkingBlocks.join("");
    state.thinkingBlocks = [];
    state.content.push({ type: "thinking", thinking: thinkingText });
    state.currentThinkingIndex = state.content.length - 1;
    emitted.push({
      type: "thinking_start",
      contentIndex: state.currentThinkingIndex,
    });
    emitted.push({
      type: "thinking_delta",
      contentIndex: state.currentThinkingIndex,
      delta: thinkingText,
    });
    emitted.push({
      type: "thinking_end",
      contentIndex: state.currentThinkingIndex,
      content: thinkingText,
    });
    state.currentThinkingIndex = -1;
  }

  return emitted;
}

// ─── Request Body ──────────────────────────────────────────────────────────

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
    modelMaxTokens?: number;
    workingDir?: string;
  },
): any {
  const maxTokens = Math.min(
    options?.maxTokens ?? options?.modelMaxTokens ?? 16384,
    200_000,
  );

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
    skills: null,
    permissionMode: "standard",
    params: {
      model,
      messages,
      tools: options?.tools && options.tools.length > 0 ? options.tools : [],
      system: options?.systemPrompt ?? "",
      max_tokens: maxTokens,
      stream: true,
    },
    threadId: crypto.randomUUID(),
  };

  return body;
}

// ─── Stop Reason Mapping ──────────────────────────────────────────────────

/**
 * Map a Command Code finish reason to pi's stop reason.
 */
export function mapStopReason(reason: unknown): "stop" | "length" | "toolUse" {
  if (reason === "tool-calls" || reason === "tool_use" || reason === "tool_calls")
    return "toolUse";
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  )
    return "length";
  return "stop";
}

// ─── Abort Helper ──────────────────────────────────────────────────────────

export function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

/**
 * Race a promise against an AbortSignal. Rejects with AbortError if signal fires first.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ─── OAuth Helpers ─────────────────────────────────────────────────────────

/**
 * Remove terminal paste wrappers and control chars from API key input.
 */
export function sanitizeApiKey(input: string): string {
  const esc = String.fromCharCode(27);
  return Array.from(
    input
      .replaceAll(`${esc}[200~`, "")
      .replaceAll(`${esc}[201~`, "")
      .replaceAll("[200~", "")
      .replaceAll("[201~", ""),
  )
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
}

/**
 * Get environment info string for CC requests.
 */
export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`;
}