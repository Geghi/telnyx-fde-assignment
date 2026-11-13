# Testing — telnyx-fde-assignment

## Layers

| Layer       | Command  | Needs                                  |
| ----------- | -------- | -------------------------------------- |
| Unit        | `npm test` | nothing |
| Integration | `npm test -- --grep integration` — against a deployed function URL, **skipped in `/ship`** | deployed Edge Function URL, MCP server running |

Test files that call live Telnyx APIs, real phone numbers, or the production
assistant are never run by `/ship`. Run them manually.

## Folder structure

```
edge-functions/
  webhook/
    src/              # handler code
    tests/            # unit tests (mocked Request / KV / Actor)
  mcp-server/
    src/              # MCP server and tool implementations
    tests/            # unit + integration tests
assistant-voice-agent/
  tests/             # tests for the setup script
```

Shared fixtures and helpers go in the closest `tests/` to the code under test.

## Isolation

Each test creates and names its own KV keys and Actor IDs (prefixed `test-`).
Never depend on leftover state from a previous run.
Tests that touch KV or Actors reset their keys in setup and teardown.
