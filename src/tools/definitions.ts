// tools/definitions.ts
import type { ToolDefinition } from "../core/types.js";
import { sBoolean, sObject, sString } from "./schema.js";

/**
 * These definitions are sent to the LLM.
 * They MUST match tools/types.ts and tools/registry.ts behavior.
 */

export const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the project. Access is restricted by policy (deny .env, .git, node_modules etc.). Returns a JSON result with file content (may be truncated).",
  parameters: sObject({
    properties: {
      path: sString(),
    },
    required: ["path"],
    additionalProperties: false,
  }),
};

export const LIST_DIR_TOOL: ToolDefinition = {
  name: "list_dir",
  description:
    "List directory entries (files/dirs) within allowed project paths. Returns a JSON result with entries (may be capped).",
  parameters: sObject({
    properties: {
      path: sString(),
    },
    required: ["path"],
    additionalProperties: false,
  }),
};

export const WRITE_FILE_TOOL: ToolDefinition = {
  name: "write_file",
  description:
    "Write a UTF-8 text file under data/outputs/*. Overwrite is disabled by default; set overwrite=true to overwrite existing file if policy allows.",
  parameters: sObject({
    properties: {
      path: sString(),
      content: sString(),
      overwrite: sBoolean(),
    },
    required: ["path", "content"],
    additionalProperties: false,
  }),
};

export const ALL_TOOLS: readonly ToolDefinition[] = [
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  WRITE_FILE_TOOL,
] as const;
