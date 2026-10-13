"""Read-only capture and conservative AE coverage; see models/market-availability-diagnosis.md."""
from datetime import datetime, timezone
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

DAY = 86_400_000
START = 1791412772517  # 2026-10-07 agent deployment, before 00:00 on 2026-10-08
ACCOUNT = "bab940ffcf652079ec6172c267afa11e"
PRODUCTS = ("BTC-USD", "ETH-USD")


def coverage(rows, start, end):
    """Observed compatible decisions, not exact state-machine admission evidence."""
    days = range(((start + DAY - 1) // DAY) * DAY, end, DAY)
    windows = [(p, d) for d in days if d + 7_200_000 <= end for p in PRODUCTS]
    compatible = set()
    for row in rows:
        ts = float(row["ts"])
        close = int(float(row.get("vobs", 0)))
        if (row["ev"] == "cycle.completed" and row["mode"] == "paper"
                and row["o"] in ("NO_ACTION", "RISK_REJECTED", "ORDER_CONFIRMED", "ORDER_REJECTED")
                and row["e"] in ("NONE", "RATE_LIMITED") and row["vq"] == "fresh"
                and close <= ts <= close + 7_200_000 and close % DAY == 0):
            compatible.add((row["p"], close))
    observed = [item for item in windows if item in compatible]
    return {
        "expectedProductWindows": len(windows), "compatibleObserved": len(observed),
        "observationRate": len(observed) / len(windows) if windows else None,
        "windows": [{"product": p, "closeUtc": datetime.fromtimestamp(d / 1000, timezone.utc).isoformat(),
                     "status": "compatible-observed" if (p, d) in compatible else "not-demonstrated"}
                    for p, d in windows],
        "sampledRows": sum(float(r["w"]) != 1 for r in rows),
        "decisionMissedEvents": sum(r["ev"] == "decision.missed" for r in rows),
    }


def decode_sequence(text):
    """Read concatenated JSON without modifying the archived evidence."""
    decoder = json.JSONDecoder()
    result, offset = [], 0
    while text[offset:].strip():
        offset += len(text[offset:]) - len(text[offset:].lstrip())
        value, offset = decoder.raw_decode(text, offset)
        result.append(value)
    return result


def archived_request_summary(text):
    counts = collections.Counter()
    retry_after = collections.Counter()
    for event in decode_sequence(text):
        for log in event.get("logs", []):
            for message in log.get("message", []):
                try:
                    item = json.loads(message)
                except (ValueError, TypeError):
                    continue
                if item.get("event") != "coinbase_market_request":
                    continue
                key = (item["kind"], item["cached"], item["status"], item["outcome"])
                counts[key] += 1
                if item["status"] == 429:
                    retry_after[str(item.get("retryAfterRaw"))] += 1
    return {"requests": [{"kind": k, "cached": c, "status": s, "outcome": o, "count": n}
                         for (k, c, s, o), n in counts.items()], "retryAfter429": dict(retry_after)}


def summarize_probes(probes, cutoff):
    normalized = {}
    for name, probe in probes.items():
        if probe.get("status") != 200 or "body" not in probe:
            continue
        venue, product = name.rsplit("-", 2)[0], "-".join(name.rsplit("-", 2)[1:])
        body = probe["body"]
        values = {}
        for candle in body.get("candles", []) if isinstance(body, dict) else body:
            if venue == "coinbase-exchange":
                start, price = int(candle[0]) * 1000, float(candle[4])
            elif venue == "hyperliquid-perp":
                start, price = int(candle["t"]), float(candle["c"])
            elif venue == "dydx-perp":
                start = int(datetime.fromisoformat(candle["startedAt"].replace("Z", "+00:00")).timestamp() * 1000)
                price = float(candle["close"])
            else:
                start, price = int(candle["start"]) * 1000, float(candle["close"])
            if start + DAY <= cutoff:
                values[start] = price
        normalized.setdefault(product, {})[venue] = values
    result = {}
    for product, venues in normalized.items():
        common = set.intersection(*(set(v) for v in venues.values()))
        latest = max(common) if common else None
        reference = venues.get("coinbase-advanced", {}).get(latest)
        result[product] = {"commonClosedStarts": sorted(common), "latestCommonStart": latest,
                           "providers": {k: {"closedCount": len(v), "close": v.get(latest),
                                              "differenceBpsVsAdvanced": (v[latest] / reference - 1) * 10000 if latest in v and reference else None}
                                         for k, v in venues.items()}}
    return result


def tail(root, seconds):
    """Read one bounded live tail; persist only an allowlist of market log fields."""
    started = datetime.now(timezone.utc).isoformat()
    with subprocess.Popen(["node_modules/.bin/wrangler", "tail", "dodash-paper-mcp-market-data", "--format", "json"],
                          cwd=Path(__file__).resolve().parents[2] / "apps/agent",
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
        try:
            stdout, _ = process.communicate(timeout=seconds)
        except subprocess.TimeoutExpired:
            # Terminate only this capture's process group, including the launcher child.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, _ = process.communicate(timeout=5)
    raw = stdout.decode()
    decoder, offset, events = json.JSONDecoder(), 0, []
    while True:
        offset = raw.find("{", offset)
        if offset < 0:
            break
        try:
            obj, end = decoder.raw_decode(raw, offset)
        except ValueError:
            offset += 1
            continue
        offset = end
        for log in obj.get("logs", []):
            for message in log.get("message", []):
                try:
                    item = json.loads(message)
                except (TypeError, ValueError):
                    continue
                if item.get("event") in ("coinbase_market_request", "coinbase_rate_limited"):
                    events.append({"timestamp": log.get("timestamp"), "versionId": obj.get("scriptVersion", {}).get("id"),
                                   **{k: item[k] for k in ("event", "kind", "productId", "cached", "status", "outcome", "retryAfterRaw", "retryAfterSeconds", "latencyMs") if k in item}})
    output = root / "live-market-tail.json"
    if output.exists():
        raise FileExistsError(output)
    output.write_text(json.dumps({"startedAt": started, "endedAt": datetime.now(timezone.utc).isoformat(), "seconds": seconds,
                                  "events": events, "note": "empty events is not proof of zero requests"}, indent=2) + "\n")
    print(json.dumps({"output": str(output), "marketLogEvents": len(events)}))


def replay(root):
    capture_data = json.loads((root / "capture.json").read_text())
    analytics = capture_data.get("analytics", {})
    retry = root / "analytics-retry.json"
    if retry.exists():
        analytics = json.loads(retry.read_text())
    rows = analytics.get("body", {}).get("data")
    if rows is not None:
        if len(rows) >= 10000:
            raise ValueError("capture may be truncated")
        summary = coverage(rows, capture_data["windowStartMs"], capture_data["windowEndMs"])
        summary["cycleOutcomes"] = dict(collections.Counter(f'{r["p"]}:{r["o"]}:{r["e"]}' for r in rows if r["ev"] == "cycle.completed"))
        (root / "coverage.json").write_text(json.dumps(summary, indent=2) + "\n")
    comparison = summarize_probes(capture_data["probes"], capture_data["windowEndMs"] // DAY * DAY)
    (root / "provider-comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.glob("*.json") if p.name != "sha256.json"}
    (root / "sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"analyticsRows": len(rows) if rows is not None else None, "providers": comparison}, indent=2))


def request(url, payload=None, token=None):
    headers = {"accept": "application/json", "User-Agent": "DoDash-read-only-diagnostic/1.0"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        headers["content-type"] = "text/plain" if isinstance(payload, str) else "application/json"
    data = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode() if payload is not None else None
    started = time.monotonic()
    result = {"url": url, "payload": payload, "executionLocation": "local-macOS", "at": datetime.now(timezone.utc).isoformat()}
    try:
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(12_000_001)
            result.update(status=response.code, headers={k: v for k, v in response.headers.items()
                          if k.lower() in ("retry-after", "content-type", "date", "server", "cf-ray", "cache-control")})
            if len(raw) > 12_000_000:
                result["error"] = "response-size-limit"
            else:
                try:
                    result["body"] = json.loads(raw)
                except ValueError:
                    result["error"] = "non-json-response"
                    result["bodySha256"] = hashlib.sha256(raw).hexdigest()
    except (OSError, TimeoutError) as error:
        result["error"] = type(error).__name__
    result["latencyMs"] = round((time.monotonic() - started) * 1000)
    return result


def capture(root):
    root.mkdir(exist_ok=False)
    end = int(datetime.now(timezone.utc).timestamp() * 1000)
    token_path = Path.home() / "Library/Preferences/.wrangler/config/default.toml"
    token_match = re.search(r'oauth_token\s*=\s*"([^\"]+)"', token_path.read_text()) if token_path.exists() else None
    token = token_match.group(1) if token_match else None
    results = {"windowStartMs": START, "windowEndMs": end, "protocol": "models/market-availability-diagnosis.md"}
    if token:
        base = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
        columns = ("_sample_interval AS w, blob1 AS ev, blob2 AS p, blob3 AS mode, blob4 AS phase, "
                   "blob5 AS o, blob6 AS e, blob8 AS vq, double1 AS ts, double2 AS lat, double12 AS vobs")
        query = (f"SELECT {columns} FROM dodash_paper_trading WHERE index1='btc-usd-paper' "
                 f"AND double1 >= {START} AND double1 < {end} ORDER BY ts ASC LIMIT 10000")
        results["analytics"] = request(base + "/analytics_engine/sql", query, token)
        results["deployments"] = {w: request(base + f"/workers/scripts/dodash-paper-{w}/deployments", token=token)
                                  for w in ("agent", "mcp-market-data")}
    else:
        results["cloudflareError"] = "no-local-oauth-token"
    cutoff = (end // DAY) * DAY
    to_iso = datetime.fromtimestamp(cutoff / 1000, timezone.utc).isoformat()
    from_iso = datetime.fromtimestamp((cutoff - 3 * DAY) / 1000, timezone.utc).isoformat()
    probes = {}
    for product in PRODUCTS:
        advanced = urllib.parse.urlencode({"start": (cutoff - 4 * DAY) // 1000, "end": (cutoff - DAY) // 1000,
                                           "granularity": "ONE_DAY", "limit": 3})
        exchange = urllib.parse.urlencode({"start": from_iso, "end": to_iso, "granularity": 86400})
        dydx = urllib.parse.urlencode({"resolution": "1DAY", "fromISO": from_iso, "toISO": to_iso, "limit": 4})
        probes[f"coinbase-advanced-{product}"] = request(f"https://api.coinbase.com/api/v3/brokerage/market/products/{product}/candles?{advanced}")
        probes[f"coinbase-exchange-{product}"] = request(f"https://api.exchange.coinbase.com/products/{product}/candles?{exchange}")
        probes[f"hyperliquid-perp-{product}"] = request("https://api.hyperliquid.xyz/info", {
            "type": "candleSnapshot", "req": {"coin": product.split("-")[0], "interval": "1d", "startTime": cutoff - 3 * DAY, "endTime": cutoff - 1}})
        probes[f"dydx-perp-{product}"] = request(f"https://indexer.dydx.trade/v4/candles/perpetualMarkets/{product}?{dydx}")
    results["probes"] = probes
    results["probeSummary"] = summarize_probes(probes, cutoff)
    archive = Path(__file__).parent / "evidence-paper-2026-10-08/market-data-tail-2026-10-07T2240-2308.json"
    if archive.exists():
        results["archivedMarketRequests"] = archived_request_summary(archive.read_text())
    (root / "capture.json").write_text(json.dumps(results, indent=2) + "\n")
    rows = results.get("analytics", {}).get("body", {}).get("data")
    if rows is not None and len(rows) < 10000:
        summary = coverage(rows, START, end)
        summary["cycleOutcomes"] = dict(collections.Counter(f'{r["p"]}:{r["o"]}:{r["e"]}' for r in rows if r["ev"] == "cycle.completed"))
        (root / "coverage.json").write_text(json.dumps(summary, indent=2) + "\n")
    manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.glob("*.json")}
    (root / "sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(root), "analyticsStatus": results.get("analytics", {}).get("status"),
                      "analyticsRows": len(rows) if rows is not None else None,
                      "probes": {k: {"status": v.get("status"), "error": v.get("error")} for k, v in probes.items()}}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tail-seconds", type=int)
    parser.add_argument("--replay", action="store_true")
    args = parser.parse_args()
    if args.replay:
        replay(args.output)
    elif args.tail_seconds is not None:
        if not 1 <= args.tail_seconds <= 600:
            parser.error("tail duration must be between 1 and 600 seconds")
        tail(args.output, args.tail_seconds)
    else:
        capture(args.output)
