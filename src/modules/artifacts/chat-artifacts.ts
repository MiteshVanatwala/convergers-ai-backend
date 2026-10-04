import { logCaught } from "../../shared/utils/log";
import { REFERENCE, extractArtifacts, referenceFor, type ArtifactType } from "./artifact-parser";
import * as artifactsService from "./artifacts.service";

export type SavedArtifactRef = { id: string; version: number; type: ArtifactType; title: string };

/**
 * Stores every <artifact> block in a finished chat answer and returns the
 * answer with each block replaced by its reference. A block that fails to
 * save stays in the text as-is, so nothing the model wrote is lost.
 */
export async function storeAnswerArtifacts(input: {
  accountId: string;
  conversationId: string;
  content: string;
}): Promise<{ content: string; artifacts: SavedArtifactRef[] }> {
  const { segments, artifacts } = extractArtifacts(input.content);
  if (artifacts.length === 0) return { content: input.content, artifacts: [] };

  const saved: SavedArtifactRef[] = [];
  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      parts.push(segment);
      continue;
    }
    try {
      const ref = await artifactsService.saveFromChat({
        accountId: input.accountId,
        conversationId: input.conversationId,
        artifact: segment,
      });
      saved.push(ref);
      parts.push(`\n\n${referenceFor(ref.id, ref.version, ref.type, ref.title)}\n\n`);
    } catch (error: unknown) {
      logCaught("artifacts.chat-artifacts.storeAnswerArtifacts", error);
      parts.push(
        `\n\n<artifact identifier="${segment.identifier ?? ""}" type="${segment.type}" title="${segment.title}">\n${segment.content}\n</artifact>\n\n`
      );
    }
  }
  return { content: parts.join("").replace(/\n{3,}/g, "\n\n").trim(), artifacts: saved };
}

/** Source included per artifact when re-sending history to a model. */
const MAX_HISTORY_ARTIFACT_CHARS = 60_000;

/**
 * Prepares stored history for the model: the most recent reference to each
 * artifact is expanded back into its full <artifact> source (so "make the
 * header blue" can edit it); older references to the same artifact become a
 * one-line note. Turns are oldest first.
 */
export async function expandHistoryArtifacts<T extends { role: string; content: string }>(
  accountId: string,
  turns: T[]
): Promise<T[]> {
  const seen = new Set<string>();
  const out: T[] = new Array(turns.length);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const matches = [...turn.content.matchAll(REFERENCE)];
    if (matches.length === 0) {
      out[i] = turn;
      continue;
    }
    let text = "";
    let last = 0;
    for (const m of matches) {
      const [whole, id, versionText, type, title] = m as unknown as [string, string, string, string, string];
      text += turn.content.slice(last, m.index);
      last = (m.index ?? 0) + whole.length;
      if (seen.has(id)) {
        text += `[Earlier version of the artifact "${title}"]`;
        continue;
      }
      seen.add(id);
      text += await expandOne(accountId, id, Number(versionText), type, title);
    }
    text += turn.content.slice(last);
    out[i] = { ...turn, content: text };
  }
  return out;
}

async function expandOne(accountId: string, id: string, version: number, type: string, title: string): Promise<string> {
  try {
    const artifact = await artifactsService.getArtifact(id);
    if (!artifact || artifact.account_id !== accountId) return `[Artifact "${title}" is no longer available]`;
    const source = await artifactsService.readVersionText(id, version);
    if (source === null) return `[Artifact "${title}" is no longer available]`;
    const clipped =
      source.length > MAX_HISTORY_ARTIFACT_CHARS
        ? `${source.slice(0, MAX_HISTORY_ARTIFACT_CHARS)}\n[…truncated]`
        : source;
    const identifier = artifact.identifier ?? id;
    const language = artifact.language ? ` language="${artifact.language}"` : "";
    return `<artifact identifier="${identifier}" type="${type}" title="${title}"${language}>\n${clipped}\n</artifact>`;
  } catch (error: unknown) {
    logCaught("artifacts.chat-artifacts.expandOne", error);
    return `[Artifact "${title}"]`;
  }
}
