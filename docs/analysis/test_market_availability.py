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

    def admission(self, **overrides):
        return self.row(cid="cycle-a", trigger=str(DAY + 1_000), admission="ADMITTED",
                        dclose=DAY, deval=DAY + 60_000, **overrides)

    def test_exact_admissions_are_deduplicated_even_if_sampled_or_completed_late(self):
        rows = [self.admission(), self.admission(w=4, ts=2 * DAY)]
        result = diagnosis.admission_coverage(rows, DAY, DAY + 7_200_000)
        self.assertEqual(result["admissionsObserved"], 1)
        self.assertEqual(result["observedLowerBoundRate"], 0.5)

    def test_legacy_rows_cannot_be_reclassified_as_exact_admissions(self):
        result = diagnosis.admission_coverage([self.row()], DAY, DAY + 7_200_000)
        self.assertIsNone(result["observedLowerBoundRate"])
        self.assertEqual(result["status"], "v4-not-observable")

    def test_late_admission_is_not_counted_as_fresh(self):
        row = self.admission()
        row["deval"] = DAY + 7_200_001
        result = diagnosis.admission_coverage([row], DAY, DAY + 7_200_000)
        self.assertEqual(result["admissionsObserved"], 0)

    def test_missed_close_is_not_the_day_of_emission(self):
        row = self.admission(ev="decision.missed", ts=2 * DAY)
        row.update(admission="MISSED", deval=0)
        result = diagnosis.admission_coverage([row], DAY, 2 * DAY + 7_200_000)
        self.assertEqual(result["missedObserved"], 1)
        self.assertEqual(result["missedWindows"][0]["closeMs"], DAY)

    def test_invalid_metadata_never_proves_an_admission(self):
        rows = []
        for changes in [{"cid": "NONE"}, {"trigger": "NaN"}, {"deval": float("inf")}, {"trigger": str(DAY - 1)}]:
            row = self.admission()
            row.update(changes)
            rows.append(row)
        self.assertEqual(diagnosis.admission_coverage(rows, DAY, DAY + 7_200_000)["admissionsObserved"], 0)


if __name__ == "__main__":
    unittest.main()
