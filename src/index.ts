/**
 * Command Code Provider for pi
 *
 * Routes requests through Command Code's /alpha/generate API.
 * Supports all models available on your Command Code plan (open-source and premium).
 *
 * Setup:
 *   1. Set COMMANDCODE_API_KEY env var
 *   2. Install: pi install git:github.com/IrvanFza/pi-commandcode-provider
 *   3. Use /model to select a Command Code model
 *
 * @module pi-commandcode-provider
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  calculateCost,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = "https://api.commandcode.ai";
const GENERATE_ENDPOINT = "/alpha/generate";
const CLI_VERSION_HEADER = "0.25.2";

// ─── API Key Resolution ────────────────────────────────────────────────────

/**
 * Resolve the Command Code API key.
 * Priority: COMMANDCODE_API_KEY env var → ~/.commandcode/auth.json
 */
function getApiKey(): string {
  if (process.env.COMMANDCODE_API_KEY) {
    return process.env.COMMANDCODE_API_KEY;
  }
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf-8"),
    );
    if (auth.apiKey) return auth.apiKey;
  } catch {
    // ignore read errors
  }
  throw new Error(
    "No Command Code API key found. Set COMMANDCODE_API_KEY or run `cmd login`.",
  );
}

// ─── Message Conversion (pi → CC OpenAI-compatible format) ─────────────────

function convertMessages(messages: Message[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const text = msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
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
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      result.push({
        role: "tool",
        tool_call_id: (msg as ToolResultMessage).toolCallId,
        content: content || "",
      });
    }
  }
  return result;
}

function convertTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  }));
}

// ─── NDJSON Stream Consumer ────────────────────────────────────────────────

/**
 * Consume a newline-delimited JSON stream from the Command Code API.
 * Also handles SSE-style "data: " prefixed lines for compatibility.
 */
async function consumeNDJSONStream(
  response: Response,
  onEvent: (event: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        const jsonStr = trimmed.startsWith("data: ")
          ? trimmed.slice(6)
          : trimmed;
        if (jsonStr === "[DONE]") return;
        try {
          onEvent(JSON.parse(jsonStr));
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Streaming Implementation ──────────────────────────────────────────────

function streamCommandCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as any,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey || getApiKey();
      const messages = convertMessages(context.messages);
      const tools = context.tools ? convertTools(context.tools) : [];

      const body: any = {
        config: {
          workingDir: process.cwd(),
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
          model: model.id,
          max_tokens: options?.maxTokens || 16384,
          stream: true,
        },
        threadId: crypto.randomUUID(),
      };

      if (tools.length > 0) body.params.tools = tools;
      if (context.systemPrompt) body.params.system = context.systemPrompt;

      const response = await fetch(`${API_BASE}${GENERATE_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-command-code-version": CLI_VERSION_HEADER,
          "x-project-slug": "pi-session",
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg =
            errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMsg = errorText;
        }
        throw new Error(
          `Command Code API error (${response.status}): ${errorMsg}`,
        );
      }

      stream.push({ type: "start", partial: output });

      let currentTextIndex = -1;
      let partialToolJson = "";
      let currentToolId = "";
      let currentToolName = "";

      await consumeNDJSONStream(
        response,
        (event: any) => {
          const t = event.type;

          // ── Text events ──
          if (t === "text-start") {
            if (currentTextIndex < 0) {
              output.content.push({ type: "text", text: "" });
              currentTextIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: currentTextIndex,
                partial: output,
              });
            }
          } else if (t === "text-delta") {
            if (currentTextIndex < 0) {
              output.content.push({ type: "text", text: "" });
              currentTextIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: currentTextIndex,
                partial: output,
              });
            }
            const delta = event.text || "";
            const block = output.content[currentTextIndex] as any;
            block.text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: currentTextIndex,
              delta,
              partial: output,
            });
          } else if (t === "text-end") {
            if (currentTextIndex >= 0) {
              const block = output.content[currentTextIndex] as any;
              stream.push({
                type: "text_end",
                contentIndex: currentTextIndex,
                content: block.text,
                partial: output,
              });
              currentTextIndex = -1;
            }

            // ── Reasoning events (ignored) ──
          } else if (
            t === "reasoning-start" ||
            t === "reasoning-delta" ||
            t === "reasoning-end"
          ) {
            // skip

            // ── Tool call events ──
          } else if (
            t === "tool-call-start" ||
            t === "tool_call_start"
          ) {
            partialToolJson = "";
            currentToolId = event.id || "";
            currentToolName = event.name || "";
          } else if (
            t === "tool-call-delta" ||
            t === "tool_call_delta"
          ) {
            partialToolJson += event.delta || event.arguments || "";
          } else if (
            t === "tool-call-end" ||
            t === "tool_call_end"
          ) {
            let args: any = {};
            try {
              args = JSON.parse(partialToolJson);
            } catch {
              // use empty args on parse failure
            }
            const toolCall: ToolCall = {
              type: "toolCall",
              id: event.id || currentToolId,
              name: event.name || currentToolName,
              arguments: args,
            };
            output.content.push(toolCall);
            const ci = output.content.length - 1;
            stream.push({
              type: "toolcall_start",
              contentIndex: ci,
              partial: output,
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex: ci,
              delta: partialToolJson,
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: ci,
              toolCall,
              partial: output,
            });
            partialToolJson = "";

            // ── Finish events ──
          } else if (t === "finish-step" || t === "finish") {
            const usage = event.usage || event.totalUsage;
            if (usage) {
              output.usage.input =
                usage.inputTokens || output.usage.input;
              output.usage.output =
                usage.outputTokens || output.usage.output;
              output.usage.cacheRead =
                usage.cachedInputTokens ||
                usage.cacheReadTokens ||
                output.usage.cacheRead;
              output.usage.cacheWrite =
                usage.cacheWriteTokens || output.usage.cacheWrite;
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite;
              calculateCost(model, output.usage);
            }
            if (event.finishReason) {
              const r = event.finishReason;
              output.stopReason =
                r === "tool_use" || r === "tool_calls"
                  ? "toolUse"
                  : r === "max_tokens" || r === "length"
                    ? "length"
                    : "stop";
            }
          }
          // start / start-step / provider-metadata — ignored
        },
        options?.signal,
      );

      // Close text block if still open
      if (currentTextIndex >= 0) {
        stream.push({
          type: "text_end",
          contentIndex: currentTextIndex,
          content: (output.content[currentTextIndex] as any).text,
          partial: output,
        });
      }

      stream.push({
        type: "done",
        reason: (output.stopReason || "stop") as
          | "stop"
          | "length"
          | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason as any,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

// ─── Model Definitions ─────────────────────────────────────────────────────

/**
 * All models available through Command Code.
 * Open-source models work on all plans. Premium models require Pro ($15/mo) or higher.
 *
 * Prices are per million tokens at API cost. Command Code plans include 2-10x credit multiplier.
 */
const models = [
  // ── Open Source Models (available on Go plan and above) ──
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.01, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.435, output: 0.87, cacheRead: 0.004, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "stepfun/Step-3.5-Flash",
    name: "Step 3.5 Flash (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.27, output: 0.95, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax M2.7 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "Qwen/Qwen3.6-Plus",
    name: "Qwen 3.6 Plus (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.5, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    id: "Qwen/Qwen3.6-Max-Preview",
    name: "Qwen 3.6 Max Preview (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM 5 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM 5.1 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  },

  // ── Premium Models (require Pro plan $15/mo or higher) ──
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (Command Code)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 16384,
  },
];

// ─── Extension Entry Point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "COMMANDCODE_API_KEY",
    api: "commandcode-generate" as any,
    models,
    streamSimple: streamCommandCode,
  });
}
