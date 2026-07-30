// Exact, DB-free fixed-point rendering shared by the local aggregate-report reader and tests.
export function formatUsd(micros: number | bigint): string {
  const m = BigInt(micros);
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}
