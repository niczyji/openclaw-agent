import { stageFile } from "../core/builder/stage";
import { diffOperation } from "../core/builder/diff";
import { applyOperation } from "../core/builder/apply";
import { rollbackOperation } from "../core/builder/rollback";

export const builderTools = [
  {
    name: "stage_file",
    description:
      "Stage a file change into data/patches/staged without modifying the repo",
    inputSchema: {
      type: "object",
      properties: {
        opId: { type: "string" },
        targetPath: { type: "string" },
        content: { type: "string" },
        note: { type: "string" },
      },
      required: ["targetPath", "content"],
    },
    run: async (args: any, ctx: any) => {
      // stage is safe in runtime too (writes only data/patches)
      return stageFile(args);
    },
  },
  {
    name: "diff_op",
    description: "Show diff for a staged operation",
    inputSchema: {
      type: "object",
      properties: { opId: { type: "string" } },
      required: ["opId"],
    },
    run: async (args: any) => diffOperation(args.opId),
  },
  {
    name: "apply_patch",
    description: "Apply a staged operation to the repo (dev/builder only)",
    inputSchema: {
      type: "object",
      properties: { opId: { type: "string" } },
      required: ["opId"],
    },
    run: async (args: any, ctx: any) => {
      if (ctx?.purpose !== "dev")
        throw new Error("apply_patch allowed only in dev mode");
      return applyOperation(args.opId);
    },
  },
  {
    name: "rollback",
    description:
      "Rollback an applied operation using backups (dev/builder only)",
    inputSchema: {
      type: "object",
      properties: { opId: { type: "string" } },
      required: ["opId"],
    },
    run: async (args: any, ctx: any) => {
      if (ctx?.purpose !== "dev")
        throw new Error("rollback allowed only in dev mode");
      return rollbackOperation(args.opId);
    },
  },
] as const;
