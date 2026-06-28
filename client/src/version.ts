// The deployed build tag, baked into the client UI bundle at release time. release.yml overwrites this
// with the git tag (e.g. "v1.2.0") right before it builds the client — exactly as it stamps
// core/src/version.ts for the server — so the wordmark's version and the server's /healthz can't drift.
// A plain module constant (not import.meta.env) so both `vite build` and the separate `bun prerender.tsx`
// pass read the identical value, with no hydration mismatch. Stays "dev" for local `bun run dev`/`build`.
export const BUILD_VERSION = "dev";
