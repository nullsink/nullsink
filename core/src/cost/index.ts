// The cost engine — public surface. Groups the three concerns the rest of the app treats as one unit:
//   pricing.ts  the rate book (rates from prices.json) + the pure cost math (costOf / holdBoundOf) and its
//               model-resolving wrappers (priceUsage / priceHoldBound)
//   usage.ts    the per-provider usage adapters that normalize each provider's wire `usage` into the
//               canonical Usage the math consumes
// Import cost functions and usage adapters from "…/cost", not the individual files.
export * from "./pricing";
export * from "./usage";
