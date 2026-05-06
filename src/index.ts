/**
 * Command Code Provider for pi
 *
 * Routes requests through Command Code's /alpha/generate API.
 * Supports all models available on your Command Code plan (open-source and premium).
 *
 * Setup:
 *   1. Set COMMANDCODE_API_KEY env var, run `cmd login`, or use `pi /login` → Command Code
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
import {
  buildRequestBody,
  closeOpenBlocks,
  convertMessages,
  convertTools,
  createStreamState,
  getEnvironmentInfo,
  processStreamEvent,
  raceAbort,
  resolveApiKey,
  abortError,
} from "./logic.js";
import { getApiKey as oauthGetApiKey, login, refreshToken } from "./oauth.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_API_BASE = "https://api.commandcode.ai";
const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE;
const CLI_VERSION_HEADER = "0.25.2";

// ─── API Key Resolution ────────────────────────────────────────────────────

function getApiKey(providedKey?: string): string | undefined {
  return resolveApiKey(providedKey);
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

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const abortUpstream = () => {
      if (!controller.signal.aborted) controller.abort();
      try {
        reader?.cancel().catch(() => undefined);
      } catch {
        // Reader cancellation is best-effort.
      }
    };

    if (options?.signal?.aborted) {
      abortUpstream();
    } else {
      options?.signal?.addEventListener("abort", abortUpstream, { once: true });
    }

    try {
      const apiKey = options?.apiKey ?? getApiKey();

      if (!apiKey) {
        const msg: AssistantMessage = {
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
          stopReason: "error" as any,
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set COMMANDCODE_API_KEY env var, or configure ~/.commandcode/auth.json.",
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: msg });
        stream.end();
        return;
      }

      const messages = convertMessages(context.messages);
      const tools = context.tools ? convertTools(context.tools) : [];

      const body = buildRequestBody(model.id, messages, {
        tools: tools.length > 0 ? tools : undefined,
        systemPrompt: context.systemPrompt,
        maxTokens: options?.maxTokens,
        modelMaxTokens: model.maxTokens,
      });

      const response = await raceAbort(
        fetch(`${API_BASE}/alpha/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-command-code-version": CLI_VERSION_HEADER,
            "x-cli-environment": "production",
            "x-project-slug": "pi-cc",
            "x-taste-learning": "false",
            "x-co-flag": "false",
            "x-session-id": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (!response.ok) {
        const errBody = await raceAbort(
          response.text().catch(() => ""),
          controller.signal,
        );
        throw new Error(`Command Code API error ${response.status}: ${errBody.slice(0, 500)}`);
      }

      stream.push({ type: "start", partial: output });

      reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const state = createStreamState();

      for (;;) {
        if (controller.signal.aborted) throw abortError("Aborted");
        const { done, value } = await raceAbort(reader.read(), controller.signal);
        if (done) {
          // Process any remaining buffered data
          if (buffer.trim()) {
            const parsed = (() => {
              try {
                return JSON.parse(buffer.trim());
              } catch {
                return undefined;
              }
            })();
            if (parsed) processStreamEvent(parsed, state);
          }
          break;
        }
        if (controller.signal.aborted) throw abortError("Aborted");

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (controller.signal.aborted) throw abortError("Aborted");
          let trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) {
            // skip SSE comments and event type lines
          } else {
            if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
            if (trimmed && trimmed !== "[DONE]") {
              try {
                const parsed = JSON.parse(trimmed);
                processStreamEvent(parsed, state);

                // Check for stream error
                if (state.streamError) {
                  throw new Error(state.streamError);
                }

                // Push each emitted pi event to the stream with partial output
                for (const piEvent of state.events.splice(0)) {
                  if (
                    piEvent.type === "text_start" ||
                    piEvent.type === "text_delta" ||
                    piEvent.type === "text_end" ||
                    piEvent.type === "thinking_start" ||
                    piEvent.type === "thinking_delta" ||
                    piEvent.type === "thinking_end" ||
                    piEvent.type === "toolcall_start" ||
                    piEvent.type === "toolcall_delta" ||
                    piEvent.type === "toolcall_end"
                  ) {
                    stream.push({ ...piEvent, partial: output });
                  }
                }

                // Sync output content with state
                output.content = state.content;
                output.usage = state.usage;
                output.stopReason = state.stopReason as any;
                calculateCost(model, output.usage);

                if (state.finished) break;
              } catch (e) {
                if (e instanceof Error && e.message === state.streamError) throw e;
                // skip unparseable lines
              }
            }
          }
        }

        if (state.finished) break;
      }

      // Close any open blocks
      const closingEvents = closeOpenBlocks(state);
      for (const piEvent of closingEvents) {
        stream.push({ ...piEvent, partial: output });
        output.content = state.content;
      }

      stream.push({
        type: "done",
        reason: (output.stopReason || "stop") as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error: unknown) {
      const reason: "aborted" | "error" = controller.signal.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage =
        reason === "aborted"
          ? "Request aborted"
          : error instanceof Error
            ? error.message
            : String(error);
      stream.push({ type: "error", reason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", abortUpstream);
      try {
        await reader?.cancel();
      } catch {
        // Reader may already be closed/cancelled.
      }
      try {
        reader?.releaseLock();
      } catch {
        // Reader may already be released by the abort path.
      }
    }
  })();

  return stream;
}

// ─── Model Definitions ─────────────────────────────────────────────────────

const MODELS = [
  // ── Premium Models (require Pro plan $15/mo or higher) ──
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (CC)",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 128_000,
  },

  // ── Open Source Models (available on Go plan and above) ──
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.435, output: 0.87, cacheRead: 0.004, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.01, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 131_072,
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 131_072,
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 131_072,
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM-5 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 131_072,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax M2.7 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5 (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.27, output: 0.95, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  {
    id: "Qwen/Qwen3.6-Max-Preview",
    name: "Qwen 3.6 Max (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "Qwen/Qwen3.6-Plus",
    name: "Qwen 3.6 Plus (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.5, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "stepfun/Step-3.5-Flash",
    name: "Step 3.5 Flash (CC)",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
];

// ─── Extension Entry Point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "COMMANDCODE_API_KEY",
    authHeader: true,
    api: "commandcode-custom" as any,
    streamSimple: streamCommandCode,
    headers: {
      "x-command-code-version": CLI_VERSION_HEADER,
      "x-cli-environment": "production",
    },
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: oauthGetApiKey,
    },
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
}