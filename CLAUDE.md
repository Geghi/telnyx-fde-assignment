# CLAUDE.md

AI Assistant & edge compute solution for the Telnyx FDE coding challenge: Voice AI assistant with conversation workflow, MCP server, Edge Functions, KV, and Stateful Actors — monorepo with Python (MCP server / assistant tools) and TypeScript (edge functions). `AGENTS.md` points here.

## Rules

- **TDD — non negoziabile.** Test che fallisce prima del codice, poi implementa.
  Skill `tdd` + `testing`. Nessuna modifica è completa senza test.
- **Test fallito → rilancia solo quello.** Leggi l'errore dell'esecuzione appena fata e rilancia solo il test che fallisce (file + nome; per l'e2e solo il progetto/browser che fallisce). La suite intera una volta sola, alla fine.
- **Orchestra, non fare tutto tu.** Il thread principale tiene il contesto e la qualità; delega ai subagent le parti piccole, ben delimitate e verificabili (ricerche, edit meccanici, test, review), con istruzioni precise: file, cosa fare, output atteso. Modello più leggero quanto basta: `haiku` per task banali, `sonnet` per il resto del delegabile. Design, decisioni, integrazione e verifica del risultato restano a te. Se il brief costa quanto il lavoro, fallo tu.
- **Code** follows [CODING_STANDARDS.md](CODING_STANDARDS.md); `/ship` reviews every diff against it.
- **Workflow** (stash, env, dev server, layout, repo-specific process):
  [docs/agents/workflow.md](docs/agents/workflow.md).
- **Docs = current state only.** Docs, PRDs, plans and map describe what the code does now: when behavior changes, update or delete the old text in the same diff. No history (git has it).

## Where to find things

| You need…                  | Open                                                  |
| -------------------------- | ----------------------------------------------------- |
| what a domain term means   | [CONTEXT.md](CONTEXT.md) (created lazily)             |
| why a choice was made      | [docs/adr/](docs/adr/)                                |
| how code must be written   | [CODING_STANDARDS.md](CODING_STANDARDS.md)            |
| how to work here           | [docs/agents/workflow.md](docs/agents/workflow.md)    |
| tests: rules, layer choice | `testing` skill                                       |
| tests: commands, folders   | [docs/agents/testing.md](docs/agents/testing.md)      |
| PR proof                   | [docs/agents/evidence.md](docs/agents/evidence.md)    |

## Commands

```bash
# Python (MCP server / assistant tools)
uv sync                          # install
ruff check .                     # lint (fix: ruff check . --fix)
mypy .                           # typecheck
pytest                           # tests

# Edge functions (TypeScript)
npm install --prefix edge-functions
npm test --prefix edge-functions

# Deploy edge functions
telnyx-edge ship                 # from edge-functions/<fn>/
```
