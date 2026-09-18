# Agentia

[![CI](https://github.com/retrychx/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/retrychx/agentia/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@migor/agentia)](https://www.npmjs.com/package/@migor/agentia) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文 README](./README.md) · **English**

**A declarative framework for building production agent services.** You declare four kinds of capability
with decorators + DI and a main agent orchestrates them; every run yields structured output and an
observable call tree (trace, cost, metrics).

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

agentia create my-app         # scaffold ships .env / .env.example
$EDITOR my-app/.env           # put ANTHROPIC_API_KEY here (export works too — real env wins)
# optional: ANTHROPIC_BASE_URL (compatible gateways), AGENTIA_MODEL (default claude-opus-5)
```

> The framework does **not** read `.env` on its own: the scaffolded `src/main.ts` calls
> `loadEnvFile()` on its first line. Real environment variables always win over the file
> (CI / docker / command line), unless you pass `loadEnvFile({ override: true })`.

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

## Observability & cost

One run == one trace (`traceId === runId`), **built in from turn 0** — not a bolt-on third-party tracing SDK:

- **Per-step accounting** — every span carries model, input/output/cache tokens, cost estimate, status and error type
- **One seam out** — `TraceSink { export(trace) }`, delivered on **both** the success and failure paths; a throwing
  sink never breaks the run. Persistence / sampling / redaction are composed outside the seam
  (`examples/observability/`, [`docs/observability.md`](./docs/observability.md))
- **Cost you can cap** — `priceOverrides` patches the price table; unpriced models emit an explicit
  `usage.unpriced` event (never a silent zero); `maxCostUsd` / `maxTotalTokens` stop the run
- **Replay** — `traceToMessages(trace)` linearises a finished trace back into model messages
- **Export** — `createOtlpExporter({ endpoint })`; `metricsSink()` (Prometheus text or OTLP metrics), zero dependency
- **Locally visible** — `agentia dev` opens an inspector panel sharing one renderer with the website Playground;
  `agentia report <trace.jsonl>` ranks which capability is slow / expensive / error-prone

## Integrations

- **Models** — `createAnthropicClient()` (default) and `createOpenAIClient()` for any OpenAI-compatible
  endpoint (DeepSeek, **Ollama**, gateways). You never need to touch a vendor SDK: pass
  `createAnthropicClient({ baseURL })` / `createOpenAIClient({ baseURL })`.
- **MCP** — `createStdioMcpConnector()` / `createStreamableHttpMcpConnector()` ship with the framework
  (stdlib only: `node:child_process` + global `fetch`); `mcpTools()` bridges the server's tools into the
  menu. The framework never imports the MCP SDK, and the `McpClientLike` seam stays open
  (bring the official SDK / a remote server / your own transport).
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
