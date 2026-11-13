# Evidence in the PR

Every change carries proof it works. The reader does not test by hand.
The agent chooses the level, at most three proofs, proportional to the change.
No PR in this repo — merge directly to `main` — but the same proof goes in the ship report.

## How to start and test

- Local start: edge functions are deployed via `telnyx-edge ship`, not run locally. MCP server: `uv run python -m src` (adjust to the actual entry point).
- Unit: `pytest` (Python packages) / `npm test` (edge functions)
- Integration: `pytest -m integration` (if configured) against the deployed Edge Function URL and MCP server running
- E2E: calling the live assistant phone number — never automatic; run manually and attach the recording

## How much to test — the three levels

### Level 0 — one line, test, config

The name of the red→green test and what it verifies, in one line.

### Level 1 — logic or endpoint

Level 0 + a real example: webhook request/response, an MCP tool call and its return,
or a prompt-node output vs expected.
(es. real request/response, tool return, before/after).

### Level 2 — visible or audible feature

Level 1 + an audio recording or transcript of the main path (calling the phone
number, walking through the conversation workflow end-to-end),
attached to the report.

- Above each capture (audio, transcript), one line: what it shows and what it proves.
  A capture without context is not evidence.
- Coverage: every behaviour the claim says is visible or audible has its own
  capture, including what should stay the same (the default path).
  A behaviour covered only by a test → add the capture.

## In the report

The format and length of the `## Evidence` section are decided by the ship
report (`guide.md` references `docs/agents/evidence.md`).
To produce evidence run only the tests that serve it, not the whole suite.
