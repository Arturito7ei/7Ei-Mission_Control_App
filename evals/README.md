# Orchestration evals (MCA-DIST S5.1)

Scenario-level checks that the control plane's decision logic is correct — the
"we handle the hard orchestration details right" guarantee. Distinct from unit
tests: these score end-to-end orchestration behaviours and gate releases.

```bash
cd backend && npm run evals     # → scored report, exit 0 all-pass / 1 on any fail
```

Scenarios: atomic checkout (one winner), orphan-run recovery, budget hard-stop,
dependency gating, per-agent permissions, run-token integrity.
