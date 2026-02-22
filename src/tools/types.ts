export type ToolName = "read_file" | "write_file" | "list_dir";

export type ToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string; overwrite?: boolean }
  | { tool: "list_dir"; path: string };

export type ToolResult = {
  ok: boolean;
  tool: ToolName;
  result?: any;
  error?: string;
};
