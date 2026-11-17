# Workflow rules

How to work in this repo. Linked from [CLAUDE.md](../../CLAUDE.md).

- **Dev server** — never run it without asking first.
- **Git stash** — always named: `git stash push -u -m "<name>"` /
  `git stash pop "stash^{/<name>"}`. Never bare stash/pop.
- **Env vars** — only read/edit `.env.example`. Never read `.env.local`.
- **Edge functions** — deployed via `telnyx-edge ship`, not run locally for
  production. Test handler logic in unit tests with mocked `Request` and bindings;
  test the full webhook against the deployed URL.
- **No PR** — merge feature branches to `main` directly. `/ship` reviews, fixes,
  and merges; it does not open a PR.
- **Docs hygiene** — delete it in the code, delete it in the docs: no doc names a
  symbol, file or route that no longer exists. Only `docs/adr/` and `docs/prd/`
  keep history.
- **Prose docs** — one sentence per line (`CONTEXT.md`, map cards, `docs/agents/`), so parallel branches rebase without conflicts.
- **Stale deps** — the post-checkout / post-rewrite hook re-runs the install when a lockfile changed; after a rebase never "fix" a gate failure by hand before it has run.

## Layout

```
edge-functions/
  webhook/                  # TypeScript — dynamic webhook variables + KV + Actor
    src/                    # handler code + CallSession actor
    tests/                  # unit tests (mocked bindings)
  mcp-server/               # TypeScript — MCP server with scheduling tools
    src/                    # MCP read tools, /tools/<name> webhook-tool routes, BookingActor, store
    tests/                  # unit tests (mocked bindings)
assistant-voice-agent/      # assistant configuration + dev tooling
  workflow.json             # conversation workflow definition (API payload)
  prompts/                  # system prompt per node
  src/                      # workflow assembly, webhook tool definitions, calendar
  setup.ts                  # registers MCP server + tools, creates/updates the assistant, binds the number
  buy-number.ts             # buys the dial-in number
  chat.ts, trace.ts         # text chat with the assistant; print a conversation
  eval/                     # scripted conversations scored by an LLM judge
docs/                       # documentation
  adr/                      # architecture decision records (lazy)
  prd/                      # product requirement docs (lazy)
  agents/                   # agent-facing docs (testing, evidence, workflow)
scripts/                    # dev scripts
  deploy-all.sh             # ship both edge functions
  seed-kv.sh                # write business_info + online_booking_enabled to KV
  list-callbacks.sh         # list call-back requests (GET /callbacks)
  sync-deps.sh              # re-install deps when a lockfile changed
```
