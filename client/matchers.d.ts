// Declaration merging so the jest-dom matchers (toBeDisabled, …) added to bun:test's expect in
// testing-library.ts are visible to TypeScript in test files. See bun.sh/guides/test/testing-library.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers {}
}
