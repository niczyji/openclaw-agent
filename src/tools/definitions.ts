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

export const RUN_CMD_TOOL: ToolDefinition = {
  name: "run_cmd",
  description:
    "Run a safe allowlisted command for verification (e.g., npm test, npm run build, tsc --noEmit, git status). Exact-match allowlist. Returns stdout/stderr.",
  parameters: sObject({
    properties: { command: sString() },
    required: ["command"],
    additionalProperties: false,
  }),
};

export const CALCULATOR_TOOL: ToolDefinition = {
  name: "calculator",
  description:
    "Evaluate a basic arithmetic expression like 2+2 or (10/2)+7. Returns JSON with the numeric result.",
  parameters: sObject({
    properties: {
      expression: sString(),
    },
    required: ["expression"],
    additionalProperties: false,
  }),
};

export const STAGE_FILE_TOOL: ToolDefinition = {
  name: "stage_file",
  description:
    "Stage a file change into data/patches/staged without modifying the repo. Used by Builder Core to prepare safe patches.",
  parameters: sObject({
    properties: {
      opId: sString(), // optional: continue an existing staged op
      targetPath: sString(), // repo-relative path (e.g. src/core/router.ts)
      content: sString(), // full file content
      note: sString(), // optional note
    },
    required: ["targetPath", "content"],
    additionalProperties: false,
  }),
};

export const DIFF_OP_TOOL: ToolDefinition = {
  name: "diff_op",
  description:
    "Show diff for a staged Builder operation (compares staged content vs current repo files).",
  parameters: sObject({
    properties: {
      opId: sString(),
    },
    required: ["opId"],
    additionalProperties: false,
  }),
};

export const APPLY_PATCH_TOOL: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a staged Builder operation to the repo with backups (dev mode only).",
  parameters: sObject({
    properties: {
      opId: sString(),
    },
    required: ["opId"],
    additionalProperties: false,
  }),
};

export const ROLLBACK_TOOL: ToolDefinition = {
  name: "rollback",
  description:
    "Rollback an applied Builder operation using backups (dev mode only).",
  parameters: sObject({
    properties: {
      opId: sString(),
    },
    required: ["opId"],
    additionalProperties: false,
  }),
};

export const ALL_TOOLS: readonly ToolDefinition[] = [
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  WRITE_FILE_TOOL,
  CALCULATOR_TOOL,
  RUN_CMD_TOOL,

  // Builder Core tools
  STAGE_FILE_TOOL,
  DIFF_OP_TOOL,
  APPLY_PATCH_TOOL,
  ROLLBACK_TOOL,
] as const;
