/// <reference lib="dom" />
// The render-error backstop: a throw in a child must surface the branded fallback (not a white screen), and
// a healthy child must pass through transparently — the whole point of wrapping every route in main.tsx.
import { test, expect, spyOn } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

function Boom(): never {
  throw new Error("kaboom");
}

test("a child that throws renders the branded fallback, not a blank screen", () => {
  // React logs the caught error to console.error (plus our componentDidCatch) — silence it and assert on the DOM.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByText(/this page hit a snag/i)).toBeInTheDocument();
  expect(screen.getByText(/something broke while rendering/i)).toBeInTheDocument();
  errSpy.mockRestore();
});

test("a healthy child passes through unchanged (transparent in the happy path)", () => {
  render(
    <ErrorBoundary>
      <p>all good</p>
    </ErrorBoundary>,
  );
  expect(screen.getByText("all good")).toBeInTheDocument();
});
