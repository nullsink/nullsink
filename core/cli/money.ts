// Shared dollar↔micro-dollar conversion for the operator CLIs. Balances live in
// micro-dollars (see ../src/cost/pricing.ts); users speak whole dollars at the CLI.
export const toMicros = (dollars: number) => Math.round(dollars * 1_000_000);
export const toDollars = (micros: number) => micros / 1_000_000;

// Parse a positive-dollar CLI arg, or print `usage` and exit(1). Centralises the
// validation the issue/topup CLIs both repeated.
export function requireDollars(arg: string | undefined, usage: string): number {
  const dollars = Number(arg);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    console.error(usage);
    process.exit(1);
  }
  return dollars;
}
