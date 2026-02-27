// tools/policy.ts
import path from "node:path";
import fs from "node:fs/promises";
import type { ToolKind } from "../core/budget.js";
import type { Purpose } from "../core/types.js";

const PROJECT_ROOT = process.cwd();

// Exact match allowlist for run_cmd:
const ALLOWLIST_CMDS = new Set([
  "npm test",
  "npm run build",
  "tsc --noEmit",
  "git status",
]);

// Read roots:
const READ_PREFIXES = [
  "src",
  "data",
  "logs",
  "notes",
  "README.md",
  "package.json",
].map((p) => path.resolve(PROJECT_ROOT, p));

// Write roots (runtime) — only outputs:
const WRITE_PREFIXES_RUNTIME = ["data/outputs"].map((p) =>
  path.resolve(PROJECT_ROOT, p),
);

// Write roots (dev) — allow repo editing if you want:
const WRITE_PREFIXES_DEV = ["data/outputs", "src"].map((p) =>
  path.resolve(PROJECT_ROOT, p),
);

// Hard deny:
const DENY_SEGMENTS = new Set([".git", "node_modules", "dist"]);
const DENY_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
]);

function normalizeUserPath(userPath: string): string {
  // normalize slashes; trim; prevent weird whitespace tricks
  const s = String(userPath ?? "").trim();
  // convert backslashes to forward slashes so "src\.." doesn't get cute
  return s.replace(/\\/g, "/");
}

function splitRelParts(fullPath: string): string[] {
  const rel = path.relative(PROJECT_ROOT, fullPath);
  return rel.split(path.sep).filter(Boolean);
}

function assertWithinRoot(fullPath: string) {
  // If relative path starts with "..", it escaped PROJECT_ROOT
  const rel = path.relative(PROJECT_ROOT, fullPath);
  if (rel === "" || rel === ".") return;

  // path.isAbsolute(rel) is typically false, but keep it as belt+braces
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path traversal blocked by policy");
  }
}

function hasDeniedSegment(fullPath: string): boolean {
  const parts = splitRelParts(fullPath);
  return parts.some((p) => DENY_SEGMENTS.has(p));
}

function isDeniedFile(fullPath: string): boolean {
  const base = path.basename(fullPath);
  return DENY_FILES.has(base);
}

function isUnderAllowedPrefixes(fullPath: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => fullPath === prefix || fullPath.startsWith(prefix + path.sep),
  );
}

/**
 * Optional hardening: block symlinks.
 * This prevents linking to /etc/passwd via a symlink under allowed dirs.
 */
async function assertNotSymlink(fullPath: string) {
  try {
    const st = await fs.lstat(fullPath);
    if (st.isSymbolicLink()) {
      throw new Error("Symlinks are denied by policy");
    }
  } catch (e: any) {
    // If file does not exist, lstat throws; that's fine for write paths.
    // We only block if it exists AND is symlink.
    if (e?.code === "ENOENT") return;
    // Other errors bubble up
    throw e;
  }
}

/**
 * Resolve and validate a user path for tool access.
 * - Blocks traversal outside project root
 * - Denies sensitive segments/files
 * - Enforces read/write prefix allowlists
 * - Optionally blocks symlinks
 */
export async function assertAllowedPath(
  userPath: string,
  opts: { kind: "read" | "write"; purpose: Purpose },
): Promise<string> {
  const cleaned = normalizeUserPath(userPath);
  if (!cleaned) throw new Error("Empty path is not allowed");

  // Disallow absolute user paths explicitly (more readable errors)
  if (path.isAbsolute(cleaned)) {
    throw new Error(`Absolute paths are denied by policy: ${userPath}`);
  }

  const full = path.resolve(PROJECT_ROOT, cleaned);

  assertWithinRoot(full);

  if (hasDeniedSegment(full))
    throw new Error(`Path denied by policy (segment): ${userPath}`);
  if (isDeniedFile(full))
    throw new Error(`Path denied by policy (file): ${userPath}`);

  if (opts.kind === "read") {
    if (!isUnderAllowedPrefixes(full, READ_PREFIXES)) {
      throw new Error(`Read path not allowed by policy: ${userPath}`);
    }
    // for read, block symlink if it exists
    await assertNotSymlink(full);
  }

  if (opts.kind === "write") {
    const writePrefixes =
      opts.purpose === "dev" ? WRITE_PREFIXES_DEV : WRITE_PREFIXES_RUNTIME;

    if (!isUnderAllowedPrefixes(full, writePrefixes)) {
      throw new Error(
        `Write path not allowed by policy (${opts.purpose}): ${userPath}`,
      );
    }

    // For write: if target exists and is symlink, block it.
    await assertNotSymlink(full);
  }

  return full;
}

export function assertAllowedCommand(command: string) {
  const cmd = String(command ?? "").trim();
  if (!cmd) throw new Error("Empty command is not allowed");
  if (!ALLOWLIST_CMDS.has(cmd)) {
    throw new Error(`Command denied by policy: ${cmd}`);
  }
  return cmd;
}

/**
 * Tool classification for budgeting.
 * Keep it dumb and deterministic.
 */
export function classifyTool(name: string): ToolKind {
  if (name === "read_file" || name === "list_dir") return "read";
  if (name === "write_file") return "write";
  if (name === "run_cmd") return "other";
  return "other";
}
