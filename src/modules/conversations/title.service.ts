import Anthropic from "@anthropic-ai/sdk";
import { getKey } from "../brain/adapters/keyStore";
import { logCaught } from "../../shared/utils/log";
import { provisionalTitle } from "./conversations.service";

const TITLE_MODEL = "claude-haiku-4-5";

/**
 * Dedicated cheap call that returns only a short sidebar title.
 * Does not touch the main chat stream / markdown body.
 */
export async function generateConversationTitle(userPrompt: string): Promise<string | null> {
  try {
    const apiKey = getKey("anthropic");
    if (!apiKey) return null;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: 80,
      messages: [
        {
          role: "user",
          content:
            "Return ONLY a JSON object with a single key \"title\" (string, max 60 chars). " +
            "No markdown, no extra keys. The title should summarize this chat opener for a sidebar:\n\n" +
            userPrompt.slice(0, 2000),
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return provisionalTitle(userPrompt);

    const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown };
    if (typeof parsed.title !== "string" || !parsed.title.trim()) {
      return provisionalTitle(userPrompt);
    }
    return provisionalTitle(parsed.title, 60);
  } catch (error: unknown) {
    logCaught("conversations.title.generateConversationTitle", error);
    return null;
  }
}
