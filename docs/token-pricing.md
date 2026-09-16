# Token value estimates

Rates verified on 2026-09-16. Values in the UI are **current API token-value estimates in USD**, not invoices, subscription charges, or historical prices. Rates are a versioned snapshot; they do not update automatically. Sol's current promotional price is guaranteed at least through November 21, 2026.

| Model | Input / 1M | Cached read / 1M | Cache write / 1M | Output / 1M |
|---|---:|---:|---:|---:|
| GPT-6 Astra | $10 | $1 | $12.50 | $50 |
| GPT-5.6 Sol | $4 | $0.40 | $5 | $20 |
| GPT-5.6 Terra | $2 | $0.20 | $2.50 | $12 |
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |
| GPT-5.5 | $5 | $0.50 | Not listed | $30 |
| Claude Fable 5 | $10 | $1 | $12.50 / $20 | $50 |
| Claude Opus 5 | $5 | $0.50 | $6.25 / $10 | $25 |
| Claude Sonnet 5 | $2 | $0.20 | $2.50 / $4 | $10 |
| Claude Haiku 4.5 (20251001) | $1 | $0.10 | $1.25 / $2 | $5 |
| Grok 4.6 | $2 | $0.50 | Not listed | $6 |
| Grok 4.5 | $2 | $0.30 | Not listed | $6 |

Claude writes are 5-minute / 1-hour cache lifetimes. Their new 1M context models have no long-context surcharge. OpenAI requests above 272K input use 2× input/cache/write rates and 1.5× output rates for the listed Astra and 5.6 models. Grok requests at or above 200K use 2× input/read/output rates. These are whole-request thresholds, not cumulative session totals. Unknown per-request context, cache lifetime, model, or provider routing prevents a complete estimate. Reasoning tokens are already in output and are never added again.

Missing service tier assumes standard public API rates; known OpenAI fast/priority is 2× and flex/batch 0.5×. Known xAI priority is 2×. Regional uplift, tax, tools, negotiated discounts and subscription entitlements are excluded. Codex's Enterprise usage rate card has special handling (including no Astra cache-write charge or long-context multiplier), so this API-equivalent value must not be treated as Codex billing.

Unknown models and custom gateway routes remain unpriced. In particular, `codex-auto-review` is not mapped to a guessed model. A partial total shows only the verified subtotal and identifies unpriced token coverage in Details. Model changes are priced from attributed usage, never by multiplying all tokens by the final model's rate.

Sources:
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Codex/ChatGPT Enterprise rate card](https://help.openai.com/en/articles/20001415)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [xAI pricing](https://docs.x.ai/developers/pricing)

Charts use minute-binned timestamped counter increments. The retained timeline is bounded; omitted or untimed usage still contributes to exact run totals but not the charts. Rate averages include idle minutes between recorded updates. The current minute is a bucket of tokens recorded so far, not a predicted rate.
