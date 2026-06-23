// Outbound-link helpers, centralized so a rotated invite or a missed security attribute
// is a one-line change rather than a hunt across pages.

// Community links — used in the footer (Layout) and the get-started page (Start).
export const GITHUB_URL = "https://github.com/nullsink";
export const DISCORD_URL = "https://discord.gg/sFK36yrBq";
export const MATRIX_URL = "https://matrix.to/#/#nullsink:matrix.org";

// Safe defaults for any external (target="_blank") anchor: noopener severs the reverse-window
// handle, noreferrer drops the Referer. Spread into the <a> ({...EXT}) so the element stays
// visible at the call site — and no anchor can forget the security-relevant rel.
export const EXT = { target: "_blank", rel: "noreferrer noopener" } as const;
