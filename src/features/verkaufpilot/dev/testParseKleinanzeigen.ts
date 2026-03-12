// src/features/verkaufpilot/dev/testParseKleinanzeigen.ts

import fs from "node:fs/promises";
import path from "node:path";
import { parseKleinanzeigenMail } from "../parseKleinanzeigenMail.js";

async function main() {
  const filePath = path.resolve(
    process.cwd(),
    "src/features/verkaufpilot/fixtures/kleinanzeigen-message-01.txt",
  );

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseKleinanzeigenMail(raw);

  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
