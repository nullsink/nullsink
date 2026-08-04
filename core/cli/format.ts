const FORMATS = ["table", "csv", "json"] as const;
export type OutputFormat = (typeof FORMATS)[number];

export function optVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parseFormat(args: string[]): OutputFormat {
  const format = optVal(args, "--format") ?? "table";
  if (!(FORMATS as readonly string[]).includes(format)) {
    console.error(`unknown --format ${format} (expected: ${FORMATS.join(" | ")})`);
    process.exit(1);
  }
  return format as OutputFormat;
}
