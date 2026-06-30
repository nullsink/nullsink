// Outbound-link helpers, centralized so a rotated invite or a missed security attribute
// is a one-line change rather than a hunt across pages.

// Community links — used in the Layout header/footer and the home orient column (HomeOrient).
export const GITHUB_URL = "https://github.com/nullsink/nullsink";
export const DISCORD_URL = "https://discord.gg/sFK36yrBq";
export const MATRIX_URL = "https://matrix.to/#/#nullsink:matrix.org";

// Safe defaults for any external (target="_blank") anchor: noopener severs the reverse-window
// handle, noreferrer drops the Referer. Spread into the <a> ({...EXT}) so the element stays
// visible at the call site — and no anchor can forget the security-relevant rel.
// aria-describedby points every external link at one sr-only "opens in a new tab" note (rendered
// once in Layout), so screen-reader users are warned of the new-tab jump without per-link markup.
export const EXT = { target: "_blank", rel: "noreferrer noopener", "aria-describedby": "ext-new-tab" } as const;
