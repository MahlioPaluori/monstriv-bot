#!/usr/bin/env node
import { formatMigrationReport, runCategoryMigration } from "../lib/google-sheets-migration.js";

function parseArguments(argv) {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply === dryRun) throw new Error("Specify exactly one mode: --dry-run or --apply");
  const spreadsheetFlag = argv.indexOf("--spreadsheet-id");
  const spreadsheetId = spreadsheetFlag >= 0 ? argv[spreadsheetFlag + 1] : undefined;
  if (spreadsheetFlag >= 0 && (!spreadsheetId || spreadsheetId.startsWith("--"))) throw new Error("--spreadsheet-id requires a value");
  const confirmFlag = argv.indexOf("--confirm");
  const confirmation = confirmFlag >= 0 ? argv[confirmFlag + 1] : undefined;
  if (apply && confirmation !== "APPLY_CATEGORY_MIGRATION") {
    throw new Error("Apply requires --confirm APPLY_CATEGORY_MIGRATION");
  }
  return { mode: apply ? "apply" : "dry-run", spreadsheetId };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const report = await runCategoryMigration(options);
  process.stdout.write(`${formatMigrationReport(report)}\n`);
  if (report.results.some((item) => item.result === "blocked")) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`Migration failed: ${error?.message || "Unknown error"}\n`);
  process.exitCode = 1;
}
