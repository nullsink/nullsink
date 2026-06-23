// QR rendering, fully self-contained. qrcode-generator is pure JS, bundled into the
// static build — no external QR service, nothing touches the network (CSP-safe; the
// page holds money). We emit an inline SVG of <rect> modules so we control the color:
// acid modules on void, matching the brand (acid glows on dark). The scannable data is
// the wallet payment URI from /buy
// (quote.pay_uri, e.g. bitcoin:<addr>?amount=<btc>) — the rail builds it, we just encode the string.
import qrcode from "qrcode-generator";

// Returns an SVG string. `fg` defaults to bone (white-on-void) — acid is reserved for the
// highlighter/CTA, and a plain white QR scans most reliably. Quiet zone (4 modules) baked in.
export function qrSvg(data: string, fg = "#ECECE6"): string {
  const qr = qrcode(0, "M"); // type 0 = auto-size, error-correction M
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const dim = count + quiet * 2;

  let rects = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="payment QR" ` +
    `fill="${fg}">${rects}</svg>`
  );
}
