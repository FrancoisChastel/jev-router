#!/usr/bin/env node
// Bin entry: always runs. Everything testable lives in main.ts.
import { main } from "./main";

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`jev-router: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
