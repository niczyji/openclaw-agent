// src/features/verkaufpilot/dev/runGmailImport.ts

import { importKleinanzeigenFromGmail } from "../gmail/importKleinanzeigenFromGmail.js";

async function main() {
  await importKleinanzeigenFromGmail();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
