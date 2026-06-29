import type { ReactNode } from "react";
import { Wordmark } from "./ui.tsx";
import { DISCORD_URL, EXT, GITHUB_URL, MATRIX_URL } from "./lib/links.ts";

// The shell shared by every route: the centered column, the header bar with the brand (a home link) and
// the nav, and the footer. Page content is the children. Kept deliberately thin — the nav links the
// adoption pages in the order a new user needs them (api → models). The footer opens with the
// never-collect chips — the site-wide trust signature (red = the "hard absolute" grammar: short,
// unqualified negations only; anything needing a caveat stays off the row) — then the policy links
// (privacy + terms) on the left and the community links (GitHub, Discord, Matrix) on the right; external
// <a> navigations are unaffected by the strict CSP.
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href="/" aria-label="nullsink home">
          <Wordmark />
        </a>
        <nav className="links">
          <a href="/api/">api</a>
          <a href="/models/">models</a>
        </nav>
      </header>
      {children}
      <footer className="foot">
        <div className="foot-row">
          <nav className="foot-links">
            <a href="/privacy/">privacy</a>
            <a href="/terms/">terms</a>
          </nav>
          <nav className="foot-links">
            <a href={GITHUB_URL} {...EXT}>
              github
            </a>
            <a href={DISCORD_URL} {...EXT}>
              discord
            </a>
            <a href={MATRIX_URL} {...EXT}>
              matrix
            </a>
          </nav>
        </div>
        {/* Quiet outline chips, not red: nine red blocks on every screen spent the danger hue on
            reassurance and left nothing for the two warnings that can cost money (no refunds; lose
            the key) — understated negations also read more credible than shouted ones.
            role="list" restores list semantics that `list-style: none` strips in Safari/VoiceOver. */}
        <ul className="nots" role="list" aria-label="what we don't collect">
          <li>no accounts</li>
          <li>no email</li>
          <li>no names</li>
          <li>no passwords</li>
          <li>no IP</li>
          <li>no request logs</li>
          <li>no cookies</li>
          <li>no analytics</li>
          <li>no trackers</li>
        </ul>
      </footer>
    </div>
  );
}
