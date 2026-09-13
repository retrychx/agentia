# Agentia

[![CI](https://github.com/retrychx/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/retrychx/agentia/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文 README](./README.md) · **English**

**A declarative framework for building agent services in TypeScript.** You declare capabilities with
decorators + DI; the main agent orchestrates them. Every run yields structured output **and** a
first-class, observable call tree — trace, per-step token/cost accounting, metrics — replayable,
auditable, shippable.

> This is a **summary**. The authoritative and always-current documentation is Chinese:
> [`docs/usage-guide.md`](./docs/usage-guide.md) (API reference, type wiring, known limits) and the
> [website](https://agentia-web.pages.dev). We keep this file short on purpose — a hand-maintained
> full translation drifts.

## Requirements

Node.js **≥ 18** (the only `engines` requirement; CI runs 18 / 20 / 22). Deno and edge runtimes are
**not** validated. The only store touching a Node builtin is `SqliteTaskStore` (needs Node ≥ 22.5 for
`node:sqlite`) — it fails with a readable error at construction time, and never breaks importing the package.

## Install

```bash
npm i @migor/agentia          # the framework
npm i -g @migor/cli           # CLI: scaffold / generate / dev inspector
export ANTHROPIC_API_KEY=sk-...   # or ANTHROPIC_AUTH_TOKEN; ANTHROPIC_BASE_URL for compatible gateways
```

## Quick start

### A. CLI

```bash
agentia create my-app
cd my-app && npm install
agentia g tool weather          # create src/tools/weather/index.ts and register it
agentia dev                     # tsx watch + local inspector panel
```

Four self-describing directories hold capabilities — the directory name **is** the kind:
`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/`; the registry is `src/registry.ts`.

### B. By hand

```ts
import { Tool, createApp, SystemPrompt } from '@migor/agentia';

class WeatherTools {
  @Tool({
    description: 'Look up the weather for a city',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  })
  get_weather(input: { city: string }): string {
    return `city=${input.city}`;
  }
}

const app = createApp({
  name: 'weather-app',
  providers: [{ provide: 'weather', useClass: WeatherTools }],
  system: new SystemPrompt().add('role', 'You are a helpful weather assistant.', true),
});

const { result } = await app.run([{ role: 'user', content: 'Weather in Shanghai?' }]);
console.log(result.finalText); // final text
console.log(result.trace);     // call tree + per-step tokens/cost (traceId === runId)
```

Or point `createApp` at the directories instead of passing providers:
`createApp({ discover: ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'], system })`.

## The four capability kinds

The model picks from one shared "menu" by `description`; the decorator decides **who controls the flow**:

| Kind | Decorator | Who controls the flow | Typical use |
|---|---|---|---|
| Tool | `@Tool` | your code (one call = one function) | deterministic work: DB, math, HTTP |
| Skill | `@Skill` | your code (scripted; model calls only at explicit `ctx.llm()`) | fixed "fetch → let the model write → post-process" pipelines |
| Sub-agent | `@SubAgent` | **the model** (own loop, trimmed context) | multi-step autonomy without polluting the main context |
| Prompt asset | `@Prompt` | pulled by the model on demand | long specs/templates that shouldn't sit in context by default |

## Runtime features

- **Triggering** — `app.run()` (sync RPC) · `AsyncRunner` (idempotency-keyed, retryable, resumable via a
  store) · `Scheduler` (cron-like) · `createHttpHandler` (`POST /run`, `POST /tasks`, `GET /tasks/:id`,
  `GET /healthz`, optional `GET /metrics`, graceful `drain()`)
- **Context budget** — `createBudgetPolicy({ budgetTokens, summarize })`
- **Hard cost caps** — `maxTotalTokens` / `maxCostUsd` (+ `priceOverrides` to price non-Anthropic models)
- **Structured output** — `resultSchema`; `result.typed` is validated, or use `fromZod<T>()` for full type inference
- **Middleware** — an onion chain around every capability call (auth, rate limiting, caching, audit)
- **Cancellation / retries / streaming / tool concurrency** — `signal`, retry policy, `onText`, `maxToolConcurrency`
- **Observability & cost** — a full trace per run (`traceId === runId`), `TraceSink` fan-out,
  `createOtlpExporter`, `metricsSink`, priced cost roll-ups (`priceOverrides`, `usage.unpriced`),
  `buildRunReport` / `agentia report`, and trace replay via `traceToMessages`

## Integrations

- **Models** — `createAnthropicClient()` (default) and `createOpenAIClient()` for any OpenAI-compatible
  endpoint (DeepSeek, **Ollama**, gateways). You never need to touch a vendor SDK: pass
  `createAnthropicClient({ baseURL })` / `createOpenAIClient({ baseURL })`.
- **MCP** — `mcpTools()` bridges an MCP server's tools into the menu (duck-typed, zero dependency)
- **Memory** — `memory: { store, keys }` for cross-run state; task stores: memory / JSONL / SQLite / Redis
- **Evals** — `scriptedClient` + `defineEval` turn mocked runs into a first-class diagnostic loop
- **Platforms** — send traces to Langfuse / Phoenix / etc. via OTLP or a tiny custom `TraceSink`
  (see [`docs/observability.md`](./docs/observability.md) §2.6)

## Documentation

| | |
|---|---|
| Usage guide (authoritative, zh) | [`docs/usage-guide.md`](./docs/usage-guide.md) |
| Production observability recipes | [`docs/observability.md`](./docs/observability.md) |
| Examples (complete app / minimal deploy / observability) | [`examples/`](./examples/) |
| Design spec & roadmap | [`docs/spec.md`](./docs/spec.md) · [`docs/roadmap.md`](./docs/roadmap.md) |
| Website · Playground | [agentia-web.pages.dev](https://agentia-web.pages.dev) · [playground](https://agentia-web.pages.dev/playground.html) |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) — and note that [`AGENTS.md`](./AGENTS.md) is the single
source for this repo's engineering conventions. Security issues: [`SECURITY.md`](./SECURITY.md)
(please don't open a public issue).

## License

[MIT](./LICENSE)
