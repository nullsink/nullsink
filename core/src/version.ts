// Build version baked into the compiled binaries. "dev" for local + CI-smoke builds; the release workflow
// (.github/workflows/release.yml) overwrites this with the git tag before building, so a released binary
// reports its release in the server boot log and GET /healthz. Zero-import leaf module.
export const BUILD_VERSION = "dev";
