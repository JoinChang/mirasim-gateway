import { main } from "./cli/index.js";

main().catch((e) => {
  process.stderr.write(`mirasim-gateway: ${e?.message ?? e}\n`);
  process.exit(1);
});
