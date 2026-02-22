import path from "node:path";

const PROJECT_ROOT = process.cwd();

// Allowed roots for any tool access:
const ALLOWED_PREFIXES = ["src", "data", "logs", "notes", "README.md", "package.json"].map((p) =>
  path.resolve(PROJECT_ROOT, p),
);

// Hard denylist (never allow)
const DENY_SEGMENTS = new Set([".git", "node_modules"]);
const DENY_FILES = new Set([".env", ".env.local", ".env.production", ".env.development"]);

function hasDeniedSegment(fullPath: string): boolean {
  const rel = path.relative(PROJECT_ROOT, fullPath);
  const parts = rel.split(path.sep);
  return parts.some((p) => DENY_SEGMENTS.has(p));
}

function isDeniedFile(fullPath: string): boolean {
  const base = path.basename(fullPath);
  return DENY_FILES.has(base);
}

export function assertAllowedPath(userPath: string) {
  const full = path.resolve(PROJECT_ROOT, userPath);

  // deny first
  if (hasDeniedSegment(full)) throw new Error(`Path denied by policy (segment): ${userPath}`);
  if (isDeniedFile(full)) throw new Error(`Path denied by policy (file): ${userPath}`);

  // allowlist
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => full === prefix || full.startsWith(prefix + path.sep),
  );
  if (!allowed) throw new Error(`Path not allowed by policy: ${userPath}`);

  return full;
}
