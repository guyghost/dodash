import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("diagnosis", Path(__file__).with_name("market-availability-2026-10-13.py"))
diagnosis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnosis)
DAY = diagnosis.DAY


class CoverageTests(unittest.TestCase):
    def row(self, **overrides):
        return {"ts": DAY + 60_000, "vobs": DAY, "ev": "cycle.completed", "mode": "paper", "p": "BTC-USD",
                "o": "NO_ACTION", "e": "NONE", "vq": "fresh", "w": 1, **overrides}

    def test_missing_days_remain_in_denominator_and_duplicates_do_not_inflate(self):
        result = diagnosis.coverage([self.row(), self.row()], DAY, 3 * DAY + 7_200_000)
        self.assertEqual(result["expectedProductWindows"], 6)
        self.assertEqual(result["compatibleObserved"], 1)

    def test_excludes_partial_windows_and_late_or_wrong_marks(self):
        self.assertEqual(diagnosis.coverage([], DAY + 1, 2 * DAY + 7_199_999)["expectedProductWindows"], 0)
        result = diagnosis.coverage([self.row(ts=DAY + 7_200_001), self.row(vobs=0)], DAY, DAY + 7_200_000)
        self.assertEqual(result["compatibleObserved"], 0)

    def test_sampling_does_not_multiply_distinct_decisions(self):
        result = diagnosis.coverage([self.row(w=4)], DAY, DAY + 7_200_000)
        self.assertEqual(result["compatibleObserved"], 1)
        self.assertEqual(result["sampledRows"], 1)

    def test_missed_events_are_not_assigned_to_emission_day(self):
        result = diagnosis.coverage([self.row(ev="decision.missed")], DAY, DAY + 7_200_000)
        self.assertEqual(result["compatibleObserved"], 0)
        self.assertEqual(result["decisionMissedEvents"], 1)

    def test_reads_json_sequence_without_counting_duplicate_error_logs(self):
        text = '{"logs":[{"message":["{\\"event\\":\\"coinbase_market_request\\",\\"kind\\":\\"candles\\",\\"cached\\":false,\\"status\\":429,\\"outcome\\":\\"RATE_LIMITED\\"}"]}]}\n{}'
        result = diagnosis.archived_request_summary(text)
        self.assertEqual(result["requests"][0]["count"], 1)

    def test_probe_comparison_excludes_open_candles_and_aligns_close_prices(self):
        probes = {
            "coinbase-advanced-BTC-USD": {"status": 200, "body": {"candles": [{"start": 0, "close": "100"}]}},
            "coinbase-exchange-BTC-USD": {"status": 200, "body": [[0, 99, 101, 100, 100, 1], [DAY // 1000, 99, 101, 100, 105, 1]]},
            "hyperliquid-perp-BTC-USD": {"status": 200, "body": [{"t": 0, "c": "101"}]},
        }
        result = diagnosis.summarize_probes(probes, DAY)["BTC-USD"]
        self.assertEqual(result["providers"]["coinbase-exchange"]["closedCount"], 1)
        self.assertAlmostEqual(result["providers"]["hyperliquid-perp"]["differenceBpsVsAdvanced"], 100)


if __name__ == "__main__":
    unittest.main()
