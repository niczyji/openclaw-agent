// src/core/builder/validate.ts
import path from "node:path";

export function assertSafeRepoRelativePath(p: string) {
  if (!p || typeof p !== "string") throw new Error("Invalid path");
  if (p.includes("\0")) throw new Error("NUL byte in path");
  if (path.isAbsolute(p)) throw new Error("Absolute paths are not allowed");

  // normalize and block traversal  ✅ FIRST
  const norm = path.posix.normalize(p.replaceAll("\\", "/"));
  if (norm.startsWith("../") || norm === "..")
    throw new Error("Path traversal blocked");
  if (norm.includes("/../")) throw new Error("Path traversal blocked");

  // Defense-in-depth: never allow Builder to stage changes to its own safety rails ✅ AFTER norm
  const blockedPrefixes = [
    "src/tools/policy",
    "src/core/builder",
    ".git",
    "node_modules",
  ];
  if (blockedPrefixes.some((bp) => norm === bp || norm.startsWith(bp + "/"))) {
    throw new Error(`Blocked by Builder guardrail: ${norm}`);
  }

  // Guardrails: allow only certain roots (v1 minimal)
  const allowed = [
    "src/",
    "package.json",
    "tsconfig.json",
    "tsup.config.ts",
    "README.md",
  ];
  const ok = allowed.some((a) => norm === a || norm.startsWith(a));
  if (!ok) throw new Error(`Path not allowed: ${norm}`);

  // Hard block sensitive zones
  const blocked = [".git/", ".env", "node_modules/", "data/patches/"];
  const bad = blocked.some((b) => norm === b || norm.startsWith(b));
  if (bad) throw new Error(`Blocked path: ${norm}`);

  return norm;
}
