// scripts/smoke-tools.ts
import { runTool } from "../src/tools/registry.js";
import { runToolFromModelCall } from "../src/tools/registry.js";

async function main() {
  console.log("== A1: direct runTool(read_file) ==");
  console.log(await runTool({ tool: "read_file", path: "notes/test.txt" }));

  console.log("\n== A1: deny .env ==");
  console.log(await runTool({ tool: "read_file", path: ".env" }));

  console.log("\n== A1: list_dir(notes) ==");
  console.log(await runTool({ tool: "list_dir", path: "notes" }));

  console.log("\n== A1: write_file allowed (data/outputs) ==");
  console.log(
    await runTool({
      tool: "write_file",
      path: "data/outputs/test-out.txt",
      content: "written by smoke test\n",
      overwrite: true,
    }),
  );

  console.log("\n== A1: write_file denied (notes/) ==");
  console.log(
    await runTool({
      tool: "write_file",
      path: "notes/should-fail.txt",
      content: "nope\n",
      overwrite: true,
    }),
  );

  console.log("\n== A1: model-style bridge runToolFromModelCall(read_file) ==");
  console.log(
    await runToolFromModelCall({
      name: "read_file",
      argumentsJson: JSON.stringify({ path: "notes/test.txt" }),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
