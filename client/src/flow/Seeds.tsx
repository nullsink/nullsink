import { Layout } from "../Layout.tsx";
import { PulseMark } from "../ui.tsx";

// TEMP page (/seeds): compare the wordmark pulse rhythm across the candidate mulberry32 seeds. Each mark
// breathes on its seed's per-square animation-delays (computed with mulberry32(seed) * 2.2, same as the
// frozen wordmark set). Not in the sitemap, noindex. DELETE this page + its nav link once a seed is picked.
const SEEDS: { seed: number; delays: string[] }[] = [
  { seed: 4817, delays: ["2.19s", "0.76s", "2.16s", "1.42s", "1.10s", "1.87s", "0.92s"] },
  { seed: 7194, delays: ["1.63s", "0.83s", "0.42s", "0.55s", "0.69s", "0.09s", "1.11s"] },
  { seed: 5686, delays: ["0.73s", "0.47s", "0.72s", "1.38s", "0.92s", "1.65s", "1.73s"] },
  { seed: 6425, delays: ["0.30s", "0.37s", "0.29s", "0.24s", "1.02s", "0.40s", "0.04s"] },
  { seed: 4297, delays: ["1.92s", "0.16s", "1.43s", "0.46s", "0.66s", "0.56s", "0.66s"] },
  { seed: 6493, delays: ["1.25s", "1.56s", "0.47s", "0.33s", "0.04s", "1.81s", "1.76s"] },
  { seed: 6464, delays: ["1.99s", "1.90s", "1.02s", "0.84s", "1.11s", "1.41s", "2.08s"] },
  { seed: 7589, delays: ["1.75s", "1.28s", "1.51s", "0.70s", "2.12s", "2.05s", "0.10s"] },
  { seed: 9628, delays: ["1.81s", "1.39s", "1.17s", "2.16s", "1.85s", "2.05s", "1.44s"] },
  { seed: 5334, delays: ["1.42s", "2.16s", "0.65s", "1.70s", "0.66s", "0.76s", "2.16s"] },
  { seed: 8760, delays: ["0.96s", "2.04s", "1.91s", "1.82s", "1.13s", "1.06s", "0.22s"] },
];

const CURRENT = 9628; // the seed the live wordmark uses

export function Seeds() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">pulse seeds</h1>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>Temp page — each mark breathes on a different mulberry32 seed. Pick the rhythm you like and I&apos;ll set the wordmark to it (then delete this page).</span>
        </p>
        <div className="seed-grid">
          {SEEDS.map(({ seed, delays }) => (
            <div className={"seed-cell" + (seed === CURRENT ? " on" : "")} key={seed}>
              <PulseMark className="seed-mark" delays={delays} />
              <span className="seed-label">
                {seed}
                {seed === CURRENT ? " · live" : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Layout>
  );
}
