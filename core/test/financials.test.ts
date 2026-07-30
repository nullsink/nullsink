import { expect, test } from "bun:test";
import { formatUsd } from "../src/ledger/financials";

test("formatUsd renders exact fixed-point micro-dollars", () => {
  expect(formatUsd(0)).toBe("0.000000");
  expect(formatUsd(57_500)).toBe("0.057500");
  expect(formatUsd(50_000_000_000n)).toBe("50000.000000");
});
