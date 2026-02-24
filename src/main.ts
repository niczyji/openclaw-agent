import { main } from "./adapters/cli";

main(process.argv.slice(2)).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
