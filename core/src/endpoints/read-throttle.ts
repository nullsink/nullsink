// The read-endpoint throttle in ONE place: the "this is a read throttle" classification + its metric live
// together at the decision site (like buy.ts records reject.* at its gates), leaving denyThrottled a pure
// envelope builder. TRUST-DOMAIN-NEUTRAL — both trust domains' read endpoints share it, so it pulls in no store, key, or rail.
// Returns the 429 to return, or null to proceed.
import { denyThrottled } from "../http";
import type { TokenBucket } from "../ratelimit";
import * as metrics from "../metrics";

export function readThrottled(bucket: TokenBucket | undefined): Response | null {
  if (bucket && !bucket.tryConsume()) {
    metrics.recordReject("read");
    return denyThrottled(1);
  }
  return null;
}
