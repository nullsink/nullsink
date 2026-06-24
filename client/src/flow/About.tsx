import { Layout } from "../Layout.tsx";
import { Ns, GitHubMark } from "../ui.tsx";
import { GITHUB_URL, EXT } from "../lib/links.ts";

// "about" (route /about): the project intro in its own voice (one engineer, open source).
// Deliberately small — the never-collect chips live in the footer (Layout.tsx) and integration lives on
// /start, so this is just the why. Claims here (no record ties you to your requests; open source)
// MUST stay true to the code, same rule as the privacy policy.
export function About() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">about</h1>

        <p className="about-copy">
          <Ns /> is a small system with one job: proxy your LLM calls so that nothing about you travels
          with them. you hold a prepaid key; the provider sees a request from us; nobody holds a record
          that ties the two together. the design goals, in order: simple, safe, reliable. anything that
          would trade one of those away doesn&apos;t ship.
        </p>
        <p className="about-copy">
          it&apos;s built and run independently — by design. staying small means fewer people who could
          ever touch your data, and no investors or growth targets pulling against your privacy; the person
          who writes the code is the one who answers your email.
        </p>
        <p className="about-copy">
          <a className="src-link" href={GITHUB_URL} {...EXT}>
            <GitHubMark className="src-icon" />
            <span>the code is <span className="hl">open source</span></span>
          </a>
        </p>
      </section>
    </Layout>
  );
}
