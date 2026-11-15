# Bug: DAO proposals stuck in `failed` state — no recovery path

**Date:** 2026-08-31
**Severity:** Medium (governance pipeline can deadlock; workaround is `dao_ship`/`dao_execute` with `force`, which defeats the gate system)
**Status:** Open

## Summary

When a proposal fails quality-control gates, it enters a terminal `failed` state with no exposed tool to recover, reset, or re-deliberate. The error message instructs "Run dao_control first", but no `dao_control` tool is available in the current environment.

## Evidence — Proposal #8

Proposal: "Standardize proposal intake: mandatory acceptance criteria, success metrics, and pre-execution risk gates" (`governance-change`, red zone, recorded in `.dao/decisions/008.json`).

Timeline (from `dao_audit`):

1. **20:19:10** — Proposal created.
2. **20:19:13** — Deliberation **approved 80%** (quorum 100%, 12 weighted for / 3 against).
3. **20:19:18** — Gates **failed**: 1 blocker — `Mandatory Dry-Run required for red-zone proposals`.
4. Dry-run executed successfully (`dao_dry_run` → "Can Proceed: ⚠️ With Caution"), **but was not recorded in the audit trail and did not clear the blocker.**
5. Every subsequent action rejected:

| Action | Error |
|---|---|
| `dao_check` | `Must be approved (current: failed)` |
| `dao_deliberate` | `Proposal #8 is failed, must be open.` |
| `dao_execute` | `Must be controlled (current: failed). Run dao_control first.` |
| `dao_ship` | `Must be controlled (current: failed). Run dao_control first.` |

## Root cause (preliminary)

1. **Missing tool:** `dao_control` is referenced by the state machine's error messages but is not exposed as an available tool.
2. **Dry-run not coupled to the gate:** the `mandatory-dry-run` blocker is not cleared by actually running `dao_dry_run` — the gate and the action that satisfies it are disconnected.
3. **Terminal failure state:** `failed` is a sink state. Deliberation requires `open`; check/execute/ship require `approved`/`controlled`. Nothing transitions `failed → open` or `failed → controlled`.

## Reproduction

1. Create a red-zone proposal and pass deliberation (`dao_propose`, `dao_deliberate`).
2. Run `dao_check` — blocker "Mandatory Dry-Run required for red-zone proposals".
3. Run `dao_dry_run` (succeeds).
4. Run `dao_check` again — stuck: `Must be approved (current: failed)`.

## Proposed fixes

1. Expose `dao_control` (or fold its function into `dao_ship`) so the `failed → controlled` transition referenced in error messages is reachable.
2. Record dry-runs in the audit trail and auto-clear the `mandatory-dry-run` blocker when one has been executed.
3. Add a `failed → open` reset (e.g. `dao_update_proposal` allowed on failed proposals, or an explicit `reopen` action) so a proposal can address gate feedback and retry without force.

## Workaround (not recommended by default)

`dao_ship(proposalId, force=true)` / `dao_execute` bypasses gates. For proposal #8 the only blocker was factually satisfied (dry-run ran; approval 80% > 66% required; risk 4.9 ≤ 7; checklist 7/7), so force would be defensible — but normalizing force-on-governance-proposals defeats the purpose of the gate system. Decision on 2026-08-31: **leave #8 failed** and fix the tooling first.
