/**
 * IDE Agent tool schemas for Brain adapters (from shared-types contract).
 */

import {
  IDE_AGENT_TOOLS,
  type IdeAgentToolName,
  type IdeAgentToolSchema,
} from "@convergers-ai/shared-types";

const BY_NAME = new Map<IdeAgentToolName, IdeAgentToolSchema>(
  IDE_AGENT_TOOLS.map((t) => [t.name, t])
);

export function resolveAgentTools(names?: IdeAgentToolName[]): IdeAgentToolSchema[] {
  if (!names || names.length === 0) {
    return [...IDE_AGENT_TOOLS];
  }
  const out: IdeAgentToolSchema[] = [];
  for (const name of names) {
    const schema = BY_NAME.get(name);
    if (schema) out.push(schema);
  }
  return out.length > 0 ? out : [...IDE_AGENT_TOOLS];
}

/** Anthropic `tools` parameter shape. */
export function toAnthropicTools(schemas: IdeAgentToolSchema[]) {
  return schemas.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.parameters.properties,
      required: t.parameters.required,
      ...(t.parameters.additionalProperties === false
        ? { additionalProperties: false }
        : {}),
    },
  }));
}
