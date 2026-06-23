// Shared CLI option parsing for the operator commands. `optVal` reads a `--name <value>` pair; `parseFormat`
// reads the `--format` flag that the table/csv/json commands (balances, financials) share — validated against
// ONE allow-list here, so the supported set is defined in a single place — exiting non-zero on an unknown
// value (the convention both CLIs already used).
const FORMATS = ["table", "csv", "json"] as const;
export type OutputFormat = (typeof FORMATS)[number];

// Value following `--name`, or undefined if the flag is absent (or has no following token).
export function optVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// Parse `--format` (default "table"); print the expected set and exit(1) on anything outside the allow-list.
export function parseFormat(args: string[]): OutputFormat {
  const format = optVal(args, "--format") ?? "table";
  if (!(FORMATS as readonly string[]).includes(format)) {
    console.error(`unknown --format ${format} (expected: ${FORMATS.join(" | ")})`);
    process.exit(1);
  }
  return format as OutputFormat;
}
