// Registers happy-dom's browser globals (document/window/etc.) before `bun test` runs, so React
// components can render headless. Wired via bunfig.toml [test].preload. See bun.sh/docs/test/dom.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
