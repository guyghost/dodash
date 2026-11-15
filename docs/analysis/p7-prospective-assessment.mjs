/** Read-only synthetic report. No checkpoint, remote export or real verdict written. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { assessP7CampaignSnapshot } = await import(require.resolve("@dodash/models"));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ?
  `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const assessP7LocalCampaign = (store, checkpoint) => {
  const { journal, generatedAt } = store.assessmentSnapshot(checkpoint);
  const report = assessP7CampaignSnapshot(journal, checkpoint);
  const anchored = { ...report, source: { sequence: journal.entries.length, journalSha256: journal.lastHash,
    replay: "LOCAL_SQLITE_VERIFIED_NOT_AUTHENTICATED" }, snapshotRecordedThroughAt: journal.state.lastRecordedAt };
  const body = canonical(anchored);
  return { report: anchored, reportSha256: createHash("sha256").update(body).digest("hex"), generatedAt };
};
