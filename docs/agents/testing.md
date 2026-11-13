# Testing — telnyx-fde-assignment

## Layers

| Layer       | Command                          | Needs                                  |
| ----------- | -------------------------------- | -------------------------------------- |
| Unit        | `pytest` (Python) / `npm test` (edge functions) | nothing |
| Integration | `pytest -m integration` — against the deployed function, **skipped in `/ship`** | deployed Edge Function URL, MCP server running |

Test files that call live Telnyx APIs, real phone numbers, or the production
assistant are never run by `/ship`. Run them manually.

## Folder structure

```
edge-functions/
  <fn-name>/
    src/         # handler code
    tests/       # unit tests for the handler (mocked Request / KV binding)
assistant-voice-agent/
  src/           # MCP server and assistant tools
  tests/         # unit + integration tests
```

Shared fixtures and helpers go in the closest `tests/` to the code under test.

## Isolation

Each test creates and names its own KV keys and Actor IDs (prefixed `test-`).
Never depend on leftover state from a previous run.
Tests that touch KV or Actors reset their keys in setup and teardown.
