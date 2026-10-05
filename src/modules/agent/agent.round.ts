/**
 * One native Agent model round via Anthropic tool_use (Track A.1).
 * Tools are never executed here — IDE Runner owns execution.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentRoundDone,
  AgentRoundMessage,
  AgentToolCall,
  IdeAgentToolName,
} from "@convergers-ai/shared-types";
import { creditsForCost } from "../ledger/ledger.service";
import * as usageService from "../usage/usage.service";
import { resolveKeyForAccount, hasOwnKey } from "../brain/adapters/accountKeyResolver";
import { nativeCost } from "../brain/adapters/pricing";
import { BYOK_FEE_CREDITS } from "../brain/router/credits";
import { UserFacingError } from "../brain/router/errors";
import { resolveAgentTools, toAnthropicTools } from "./agent.tools";

const AGENT_SYSTEM = `You are Aikya Agent in the user's IDE workspace.
Use the provided tools to explore and change files. The IDE executes tools and returns results.
Rules:
- Prefer tools over guessing about the codebase.
- Read before editing existing files.
- At most ONE write tool (search_replace or write_file) per turn; put further edits after you see the save result.
- Paths must stay inside the workspace.
- Shell commands require user approval in the IDE — prefer non-interactive commands.
- When finished, answer the user in plain text (no tool calls).`;

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_PROVIDER_ID = "anthropic:claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 16000;

const ANTHROPIC_PROVIDER_IDS = new Set([
  "anthropic:claude-haiku-4-5",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-opus-5",
]);

const MODEL_BY_PROVIDER: Record<string, string> = {
  "anthropic:claude-haiku-4-5": "claude-haiku-4-5",
  "anthropic:claude-sonnet-5": "claude-sonnet-5",
  "anthropic:claude-opus-5": "claude-opus-5",
};

function pickProvider(providerId?: string): { providerId: string; model: string } {
  if (providerId && ANTHROPIC_PROVIDER_IDS.has(providerId)) {
    return { providerId, model: MODEL_BY_PROVIDER[providerId] ?? DEFAULT_MODEL };
  }
  // Auto / non-Anthropic → Sonnet for Agent tool rounds (A.1).
  return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL };
}

function toAnthropicMessages(messages: AgentRoundMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content?.trim()) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const call of msg.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // tool → Anthropic expects tool_result on a user turn
    out.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        },
      ],
    });
  }

  return out;
}

function extractToolCalls(content: Anthropic.ContentBlock[]): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    calls.push({
      id: block.id,
      name: block.name,
      arguments:
        block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {},
    });
  }
  return calls;
}

export type AgentRoundHandlers = {
  onDelta?: (text: string) => void;
  onToolCalls?: (calls: AgentToolCall[]) => void;
};

export async function runAnthropicAgentRound(opts: {
  accountId: string;
  messages: AgentRoundMessage[];
  toolNames?: IdeAgentToolName[];
  providerId?: string;
  conversationId?: string;
  handlers?: AgentRoundHandlers;
}): Promise<AgentRoundDone> {
  if (!opts.messages.length) {
    throw new UserFacingError("messages are required", { code: "validation_failed" });
  }

  const { providerId, model } = pickProvider(opts.providerId);
  const tools = toAnthropicTools(resolveAgentTools(opts.toolNames));
  const apiKey = await resolveKeyForAccount(providerId, "anthropic", "Anthropic", opts.accountId);
  const client = new Anthropic({ apiKey });

  const byok = await hasOwnKey("anthropic", opts.accountId);
  const anthropicMessages = toAnthropicMessages(opts.messages);

  const stream = client.messages.stream({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: AGENT_SYSTEM,
    tools,
    messages: anthropicMessages,
  });

  if (opts.handlers?.onDelta) {
    stream.on("text", opts.handlers.onDelta);
  }

  const response = await stream.finalMessage();
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length > 0) {
    opts.handlers?.onToolCalls?.(toolCalls);
  }

  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
  const costUsd = nativeCost(model, usage);
  const creditsRequested = byok ? BYOK_FEE_CREDITS : creditsForCost(costUsd);

  const { charged } = await usageService.recordSuccessAndDebit({
    accountId: opts.accountId,
    conversationId: opts.conversationId,
    taskType: "code",
    provider: providerId,
    tokensInput: usage.input_tokens,
    tokensOutput: usage.output_tokens,
    nativeCost: costUsd,
    creditsRequested,
    fallbackUsed: false,
    redactedCount: 0,
    redactedTypes: null,
  });

  const stop_reason: AgentRoundDone["stop_reason"] =
    toolCalls.length > 0
      ? "tool_use"
      : response.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";

  return {
    stop_reason,
    provider_used: providerId,
    usage,
    credits_charged: charged,
    content: text || undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    truncated: response.stop_reason === "max_tokens",
  };
}
