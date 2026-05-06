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
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  buildRequestBody,
  convertMessages,
  convertTools,
  createStreamState,
  mapStopReason,
  parseNDJSON,
  processStreamEvent,
  resolveApiKey,
} from "./logic.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = "https://api.commandcode.ai";
const GENERATE_ENDPOINT = "/alpha/generate";
const CLI_VERSION_HEADER = "0.25.2";

// ─── API Key Resolution ────────────────────────────────────────────────────

function getApiKey(): string {
  return resolveApiKey(
    undefined,
    process.env.COMMANDCODE_API_KEY,
    (path) => readFileSync(path, "utf-8"),
    homedir(),
  );
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

      const body = buildRequestBody(model.id, messages, {
        tools: tools.length > 0 ? tools : undefined,
        systemPrompt: context.systemPrompt,
        maxTokens: options?.maxTokens,
      });

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

      const state = createStreamState();

      await consumeNDJSONStream(
        response,
        (event: any) => {
          const emitted = processStreamEvent(event, state);

          // Push each emitted pi event to the stream with partial output
          for (const piEvent of emitted) {
            if (piEvent.type === "text_start") {
              stream.push({ ...piEvent, partial: output });
            } else if (piEvent.type === "text_delta") {
              // Sync output content with state
              output.content = state.content;
              stream.push({ ...piEvent, partial: output });
            } else if (piEvent.type === "text_end") {
              stream.push({ ...piEvent, partial: output });
            } else if (piEvent.type === "toolcall_start") {
              output.content = state.content;
              stream.push({ ...piEvent, partial: output });
            } else if (piEvent.type === "toolcall_delta") {
              stream.push({ ...piEvent, partial: output });
            } else if (piEvent.type === "toolcall_end") {
              stream.push({ ...piEvent, partial: output });
            }
          }

          // Sync finish data
          if (event.type === "finish-step" || event.type === "finish") {
            output.usage = state.usage;
            output.stopReason = state.stopReason as any;
            calculateCost(model, output.usage);
          }
        },
        options?.signal,
      );

      // Close text block if still open
      if (state.currentTextIndex >= 0) {
        stream.push({
          type: "text_end",
          contentIndex: state.currentTextIndex,
          content: (output.content[state.currentTextIndex] as any).text,
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
