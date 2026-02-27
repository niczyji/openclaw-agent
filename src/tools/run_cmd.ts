// tools/run_cmd.ts
import { spawn } from "node:child_process";
import { assertAllowedCommand } from "./policy.js";

export async function runCmd(call: { command: string }) {
  const cmd = assertAllowedCommand(call.command);

  // Prosty parser: "npm test" -> bin="npm", args=["test"]
  const [bin, ...args] = cmd.split(" ");

  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({
        ok: code === 0,
        tool: "run_cmd",
        result: {
          command: cmd,
          code,
          stdout: stdout.slice(0, 8000),
          stderr: stderr.slice(0, 8000),
        },
      });
    });
  });
}
