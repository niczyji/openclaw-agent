// src/features/verkaufpilot/dev/testMultipleFixtures.ts

import fs from "node:fs/promises";
import path from "node:path";
import { parseKleinanzeigenMail } from "../parseKleinanzeigenMail.js";

async function main() {
  const fixturesDir = path.resolve(
    process.cwd(),
    "src/features/verkaufpilot/fixtures",
  );

  const files = await fs.readdir(fixturesDir);
  const targetFiles = files
    .filter((file) => file.endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of targetFiles) {
    const filePath = path.join(fixturesDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseKleinanzeigenMail(raw);

    console.log(`\n=== ${file} ===`);
    console.log(JSON.stringify(parsed, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
