import { Layout } from "../Layout.tsx";

// "404" — the not-found page. Output is dist/404.html (see prerender.tsx); the Caddyfile's handle_errors
// serves this body for any unmatched path while KEEPING the 404 status. Deliberately NOT in the ROUTES
// table: it's never a navigable or sitemap destination, only the fallback routeFor() returns for a path
// that matches nothing — so the client hydrates the SAME view the server prerendered for that URL (no
// hydration mismatch; see routes.tsx).
//
// Reuses the landing hero's .note type treatment (so the h1 reads as body text, not a UA heading) but
// drops the acid .marker square the landing notes carry — on an error page the lone accent is the literal
// "404" as the highlighter block (.hl), a short token getting the sanctioned "this is the point" treatment.
// Body is one calm prose line (.about-copy); the header nav and footer (Layout) carry the escape routes,
// so the page adds no link row of its own. Render-pure (no browser APIs): prerenders and reads with JS off.
export function NotFound() {
  return (
    <Layout>
      <section className="hero">
        <h1 className="note">
          <span>
            <span className="hl">404</span> — nothing at this address.
          </span>
        </h1>
      </section>

      <section className="section">
        <p className="about-copy">
          This page went down the sink — the URL doesn&apos;t match anything we serve. It may have moved,
          or it never existed.
        </p>
      </section>
    </Layout>
  );
}
