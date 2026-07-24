#!/usr/bin/env python3
"""Validate collector freshness/schema, prune exact retained pairs, and record success."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STAMP_PATTERN = r"[0-9]{8}T[0-9]{6}Z"
ARTIFACT_RE = re.compile(rf"^backup-({STAMP_PATTERN})\.tar\.age$")
REPORT_RE = re.compile(rf"^report-({STAMP_PATTERN})\.json$")
MONEY_RE = re.compile(r"^[0-9]+$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
ASSET_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class StoreError(ValueError):
    pass


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StoreError(f"{label} must be an object")
    actual = set(value)
    if actual != expected:
        raise StoreError(f"{label} keys must be exactly {sorted(expected)}; got {sorted(actual)}")
    return value


def nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise StoreError(f"{label} must be a non-negative integer")
    return value


def money(value: Any, label: str) -> str:
    if not isinstance(value, str) or MONEY_RE.fullmatch(value) is None:
        raise StoreError(f"{label} must be an unsigned decimal string")
    return value


def validate_report(path: Path, stamp: str, artifact_name: str) -> None:
    try:
        raw = path.read_text(encoding="utf-8")
        report = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StoreError(f"cannot read report {path.name}: {exc}") from exc

    root = exact_keys(report, {"schema_version", "snapshot", "finance", "operations"}, "report")
    if root["schema_version"] != 1:
        raise StoreError("report.schema_version must be 1")

    snapshot = exact_keys(root["snapshot"], {"created_at", "artifact", "validation"}, "report.snapshot")
    expected_created = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    if snapshot != {
        "created_at": expected_created,
        "artifact": artifact_name,
        "validation": "restore-dry-run-ok",
    }:
        raise StoreError("report.snapshot does not match its validated artifact")

    finance = exact_keys(root["finance"], {"revenue_by_day_asset", "liability"}, "report.finance")
    liability = exact_keys(finance["liability"], {"outstanding_micros"}, "report.finance.liability")
    money(liability["outstanding_micros"], "report.finance.liability.outstanding_micros")
    revenue = finance["revenue_by_day_asset"]
    if not isinstance(revenue, list):
        raise StoreError("report.finance.revenue_by_day_asset must be an array")
    for index, item in enumerate(revenue):
        row = exact_keys(
            item,
            {"date", "asset", "sales", "credited_micros", "gross_micros"},
            f"report.finance.revenue_by_day_asset[{index}]",
        )
        if not isinstance(row["date"], str) or DATE_RE.fullmatch(row["date"]) is None:
            raise StoreError(f"revenue row {index} has an invalid date")
        if not isinstance(row["asset"], str) or ASSET_RE.fullmatch(row["asset"]) is None:
            raise StoreError(f"revenue row {index} has an invalid asset")
        nonnegative_int(row["sales"], f"revenue row {index} sales")
        money(row["credited_micros"], f"revenue row {index} credited_micros")
        money(row["gross_micros"], f"revenue row {index} gross_micros")

    operations = exact_keys(root["operations"], {"open_orders", "undelivered_credits"}, "report.operations")
    open_orders = exact_keys(
        operations["open_orders"], {"count", "credit_micros", "payment_seen"}, "report.operations.open_orders"
    )
    nonnegative_int(open_orders["count"], "report.operations.open_orders.count")
    money(open_orders["credit_micros"], "report.operations.open_orders.credit_micros")
    nonnegative_int(open_orders["payment_seen"], "report.operations.open_orders.payment_seen")
    undelivered = exact_keys(
        operations["undelivered_credits"],
        {"count", "micros", "oldest_age_seconds"},
        "report.operations.undelivered_credits",
    )
    nonnegative_int(undelivered["count"], "report.operations.undelivered_credits.count")
    money(undelivered["micros"], "report.operations.undelivered_credits.micros")
    if undelivered["oldest_age_seconds"] is not None:
        nonnegative_int(
            undelivered["oldest_age_seconds"], "report.operations.undelivered_credits.oldest_age_seconds"
        )


def stamp_epoch(stamp: str) -> float:
    return datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        tmp.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def run(store: Path, state_dir: Path, max_age_hours: int, retention_days: int, now: float) -> None:
    if not store.is_absolute() or store == Path("/"):
        raise StoreError("store must be an absolute non-root path")
    if not state_dir.is_absolute() or state_dir == Path("/"):
        raise StoreError("state-dir must be an absolute non-root path")
    store.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    artifacts: dict[str, Path] = {}
    reports: dict[str, Path] = {}
    for path in store.iterdir():
        artifact_match = ARTIFACT_RE.fullmatch(path.name)
        report_match = REPORT_RE.fullmatch(path.name)
        if artifact_match is None and report_match is None:
            continue
        if path.is_symlink() or not path.is_file():
            raise StoreError(f"retained entry is not a regular file: {path.name}")
        if path.stat().st_size <= 0:
            raise StoreError(f"retained file is empty: {path.name}")
        if artifact_match is not None:
            artifacts[artifact_match.group(1)] = path
        else:
            assert report_match is not None
            reports[report_match.group(1)] = path

    if not artifacts:
        raise StoreError("no encrypted backup artifacts are retained")
    latest_stamp = max(artifacts, key=stamp_epoch)
    artifact = artifacts[latest_stamp]
    report = reports.get(latest_stamp)
    if report is None:
        raise StoreError(f"newest artifact has no matching aggregate report: {artifact.name}")
    validate_report(report, latest_stamp, artifact.name)

    snapshot_epoch = stamp_epoch(latest_stamp)
    age_seconds = now - snapshot_epoch
    if age_seconds < -300:
        raise StoreError(f"newest snapshot is unexpectedly in the future: {latest_stamp}")
    if age_seconds > max_age_hours * 3600:
        raise StoreError(
            f"newest snapshot is stale: {latest_stamp} is {int(age_seconds // 60)} minutes old "
            f"(limit {max_age_hours} hours)"
        )

    cutoff = now - retention_days * 86400
    pruned = 0
    for stamp in sorted(set(artifacts) | set(reports), key=stamp_epoch):
        if stamp == latest_stamp or stamp_epoch(stamp) >= cutoff:
            continue
        for path in (artifacts.get(stamp), reports.get(stamp)):
            if path is not None:
                path.unlink()
                pruned += 1

    marker = {
        "schema_version": 1,
        "checked_at": datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_artifact": artifact.name,
        "snapshot_at": datetime.fromtimestamp(snapshot_epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": max(0, int(age_seconds)),
        "artifact_bytes": artifact.stat().st_size,
        "report_bytes": report.stat().st_size,
    }
    atomic_json(state_dir / "last-success.json", marker)
    print(
        f"backup-store: OK latest={artifact.name} age_minutes={max(0, int(age_seconds // 60))} "
        f"artifacts={len(artifacts)} reports={len(reports)} pruned_files={pruned}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--max-age-hours", type=int, required=True)
    parser.add_argument("--retention-days", type=int, required=True)
    parser.add_argument("--now-epoch", type=float, default=time.time(), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.max_age_hours <= 0 or args.retention_days <= 0:
        parser.error("age and retention values must be positive")
    try:
        run(args.store, args.state_dir, args.max_age_hours, args.retention_days, args.now_epoch)
    except (StoreError, OSError, ValueError) as exc:
        print(f"backup-store: ERROR {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
