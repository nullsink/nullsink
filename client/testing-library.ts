// Extends bun:test's expect with @testing-library/jest-dom matchers (toBeDisabled, toBeInTheDocument,
// …) and unmounts rendered trees after each test. Preloaded alongside happydom.ts via bunfig.toml.
import { afterEach, expect } from "bun:test";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});
