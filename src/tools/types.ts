// tools/types.ts
export type ToolName = "read_file" | "write_file" | "list_dir";

export type ReadFileCall = Readonly<{ tool: "read_file"; path: string }>;
export type WriteFileCall = Readonly<{
  tool: "write_file";
  path: string;
  content: string;
  overwrite?: boolean;
}>;
export type ListDirCall = Readonly<{ tool: "list_dir"; path: string }>;

export type ToolCall = ReadFileCall | WriteFileCall | ListDirCall;

/** Results */
export type ReadFileResult = Readonly<{
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}>;

export type ListDirEntry = Readonly<{ name: string; type: "dir" | "file" }>;

export type ListDirResult = Readonly<{
  path: string;
  totalEntries: number;
  returnedEntries: number;
  entries: readonly ListDirEntry[];
}>;

export type WriteFileResult = Readonly<{
  path: string;
  bytes: number;
}>;

export type ToolSuccessResultMap = Readonly<{
  read_file: ReadFileResult;
  list_dir: ListDirResult;
  write_file: WriteFileResult;
}>;

export type ToolResult =
  | Readonly<{ ok: true; tool: "read_file"; result: ReadFileResult }>
  | Readonly<{ ok: true; tool: "list_dir"; result: ListDirResult }>
  | Readonly<{ ok: true; tool: "write_file"; result: WriteFileResult }>
  | Readonly<{ ok: false; tool: ToolName; error: string }>;
