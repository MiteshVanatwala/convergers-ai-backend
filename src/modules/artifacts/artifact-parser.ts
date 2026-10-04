/**
 * Finds the <artifact> blocks a model wrote (see ARTIFACT_GUIDE in
 * brain/adapters/types.ts) and swaps them for compact references the chat
 * renders as cards:
 *
 *   [[artifact:<id>@<version>|<type>|<title>]]
 *
 * The reference carries type and title so a card renders without a request;
 * the id + version say which stored content to open.
 */

export const ARTIFACT_TYPES = ["html", "react", "svg", "markdown", "mermaid", "code"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export type ParsedArtifact = {
  identifier: string | null;
  type: ArtifactType;
  title: string;
  language: string | null;
  content: string;
  /** The model stopped before closing the block (e.g. hit its output limit). */
  incomplete: boolean;
};

const BLOCK = /<artifact\b([^>]*)>([\s\S]*?)(<\/artifact>|$)/g;
const ATTR = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;
export const REFERENCE = /\[\[artifact:([0-9a-f-]{36})@(\d+)\|([a-z]+)\|([^\]\n]*)\]\]/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}

function normalizeType(raw: string | undefined, content: string): ArtifactType {
  const t = (raw ?? "").toLowerCase().trim();
  if ((ARTIFACT_TYPES as readonly string[]).includes(t)) return t as ArtifactType;
  if (t === "md" || t === "document" || t === "text/markdown") return "markdown";
  if (t === "jsx" || t === "tsx" || t === "application/vnd.react") return "react";
  if (t === "text/html") return "html";
  if (t === "image/svg+xml") return "svg";
  if (/^\s*<svg\b/i.test(content)) return "svg";
  if (/^\s*<!doctype html|^\s*<html\b/i.test(content)) return "html";
  return "code";
}

/** Models sometimes wrap the content in a code fence despite being told not to. */
function stripFence(content: string): string {
  const trimmed = content.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const fenced = trimmed.match(/^```[\w+-]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1]! : trimmed;
}

/** Characters that would break the reference syntax. */
export function referenceSafe(text: string): string {
  return text.replace(/[|\]\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function extractArtifacts(text: string): { segments: (string | ParsedArtifact)[]; artifacts: ParsedArtifact[] } {
  const segments: (string | ParsedArtifact)[] = [];
  const artifacts: ParsedArtifact[] = [];
  let last = 0;
  for (const m of text.matchAll(BLOCK)) {
    const start = m.index ?? 0;
    if (start > last) segments.push(text.slice(last, start));
    const a = attrs(m[1] ?? "");
    const content = stripFence(m[2] ?? "");
    if (!content.trim()) {
      last = start + m[0].length;
      continue;
    }
    const incomplete = m[3] !== "</artifact>";
    const title = referenceSafe(a.title || a.identifier || "Untitled") || "Untitled";
    const parsed: ParsedArtifact = {
      identifier: a.identifier ? a.identifier.trim().slice(0, 80) : null,
      type: normalizeType(a.type, content),
      title: incomplete ? `${title} (incomplete)` : title,
      language: a.language ? a.language.trim().slice(0, 30) : null,
      content,
      incomplete,
    };
    segments.push(parsed);
    artifacts.push(parsed);
    last = start + m[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return { segments, artifacts };
}

export function referenceFor(id: string, version: number, type: ArtifactType, title: string): string {
  return `[[artifact:${id}@${version}|${type}|${referenceSafe(title)}]]`;
}
