# Phase 3 — Anthropic Claude Integration

The system uses Claude in three places: research scoring (Haiku 4.5, cheap, structured tool_use with translations), content + rewrite (Opus 4.7, high quality), review + learning (Opus 4.7). All three paths share the same `generateStructured` helper.

If you're using Claude Code, **invoke the `claude-api` skill** before you start this phase — it covers prompt caching, tool_use, model IDs, and migration patterns. The notes below are Lara-Creator-specific on top of that.

## 3.1 Get an Anthropic API key

1. Sign up at https://console.anthropic.com
2. Go to **API Keys** → **Create Key**
3. Add to `.env.local`:

```bash
ANTHROPIC_API_KEY="sk-ant-api03-..."
```

Budget check: typical owner produces ~30 posts/month. Research Haiku ≈ $0.10/mo. Content Opus ≈ $3/mo. Review/learning Opus ≈ $1/mo. Total Anthropic cost ≈ $5/mo per active owner. Set a usage limit in console.anthropic.com → Billing.

## 3.2 Model IDs in `src/lib/constants.ts`

These are the exact model IDs the system uses. **Do not substitute** unless you verify the replacement works with `tool_use` and `cache_control`:

```ts
export const MODELS = {
  premium: "claude-opus-4-7",                  // content, review, learning, rewrite
  fast: "claude-haiku-4-5-20251001",           // research scoring + Hebrew translation
} as const;
```

Pricing (used by `estimateCost`):

```ts
const PRICING = {
  "claude-opus-4-7":          { input: 15, output: 75 },   // $/Mtok
  "claude-haiku-4-5-20251001":{ input:  1, output:  5 },
};
```

## 3.3 The Anthropic client singleton

Create `src/lib/ai/client.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!cached) {
    cached = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return cached;
}

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":           { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input:  1, output:  5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model] ?? PRICING["claude-opus-4-7"];
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
```

Lazy initialization (`anthropic()` returns the same instance on every call) is important because the Next.js runtime may import this module from multiple places.

## 3.4 The `generateStructured` helper

Create `src/lib/ai/generate.ts`. This is the central JSON-output function used by every agent:

```ts
import { anthropic, estimateCost } from "./client";

export interface AiResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function generateStructured<T>(opts: {
  model: string;
  system: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<AiResult<T>> {
  const response = await anthropic().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2400,
    system: [
      {
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },     // ← prompt caching
      },
    ],
    messages: [{ role: "user", content: opts.userPrompt }],
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.schema as any,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block");
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    data: block.input as T,
    model: opts.model,
    inputTokens,
    outputTokens,
    costUsd: estimateCost(opts.model, inputTokens, outputTokens),
  };
}
```

Three patterns matter:

### Pattern 1 — `tool_choice: { type: "tool", name }`

Forces Claude to call your tool. Without it, the model might emit prose first and call the tool only sometimes. With it, the response **always** contains a `tool_use` block matching your schema.

### Pattern 2 — `cache_control: { type: "ephemeral" }` on the system prompt

The system prompts in this project are large (research is ~3000 tokens, content is ~2000 tokens). Without caching, every call pays input tokens for the full system prompt. With caching, the second and subsequent calls within 5 minutes pay ~10% of the system prompt cost. For research that runs hourly + content that runs every approval, this is roughly a 70% cost reduction.

### Pattern 3 — `maxTokens` proportional to schema complexity

A common bug: too-small `max_tokens` truncates the model's tool_use output mid-stream, returning `block.input` with missing required fields. The handler then crashes on `result.data.scores.find(...)` because `scores` is undefined.

**Rule of thumb:** for a structured array of N items, budget **~250 tokens per item** when each item has 4-7 fields and includes a translation. For research with 20 candidates returning index + titleHe + summaryHe + 3 scores + postIdea + rationale, use `maxTokens: 6000` (3× safety margin). (Gotcha #18.)

If you can't increase `maxTokens` (cost), make the handler defensive:

```ts
if (Array.isArray(result.data?.scores) && result.data.scores.length > 0) {
  scores = result.data.scores;
} else {
  console.warn("[research] Haiku returned no scores — fallback to mockScore");
  scores = candidates.map((c, i) => mockScore(c, i));
}
```

## 3.5 `src/lib/env.ts` — env var access

Create `src/lib/env.ts` so handlers don't read `process.env` directly:

```ts
export const env = {
  anthropicApiKey:         (process.env.ANTHROPIC_API_KEY ?? "").trim(),
  falApiKey:               (process.env.FAL_API_KEY ?? "").trim(),
  kieApiKey:               (process.env.KIE_API_KEY ?? "").trim(),
  blotatoApiKey:           (process.env.BLOTATO_API_KEY ?? "").trim(),
  supabaseServiceRoleKey:  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(),
  ownerEmail:              (process.env.OWNER_EMAIL ?? "").toLowerCase().trim(),
  cronSecret:              (process.env.CRON_SECRET ?? "").trim(),
  appUrl:                   process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  isProd:                   process.env.NODE_ENV === "production",
};

export function hasAnthropicKey():           boolean { return env.anthropicApiKey.length > 0; }
export function hasFalKey():                 boolean { return env.falApiKey.length > 0; }
export function hasKieKey():                 boolean { return env.kieApiKey.length > 0; }
export function hasBlotatoKey():             boolean { return env.blotatoApiKey.length > 0; }
export function hasSupabaseServiceRoleKey(): boolean { return env.supabaseServiceRoleKey.length > 0; }

export function supabaseUrl(): string {
  // Derive project ref from DATABASE_URL (postgres.{ref}:password@aws-...)
  const m = (process.env.DATABASE_URL ?? "").match(/postgres\.([a-z0-9]+):/);
  if (!m) throw new Error("DATABASE_URL is not in Supabase pooler format");
  return `https://${m[1]}.supabase.co`;
}
```

The `.trim()` on every read is defensive — Vercel/Railway env editors sometimes leave trailing newlines that silently break API auth.

`hasXxxKey()` lets agents fall back gracefully when a key is missing (`hasAnthropicKey()` false → use `mockScore`, `hasKieKey()` false → use placeholder provider, etc.).

## 3.6 Prisma singleton

Create `src/lib/prisma.ts` so handlers share one connection pool:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

`globalThis` cache prevents the dev-mode hot-reload from spawning a new pool on every save.

## 3.7 Verify

Write a quick smoke test:

```js
// scripts/verify-anthropic.mjs
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const r = await a.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 100,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});
console.log(r.content[0].type === "text" ? r.content[0].text : r);
```

Run:
```bash
unset ANTHROPIC_API_KEY
npx dotenv -e .env.local -- node scripts/verify-anthropic.mjs
```

Should print `OK`. If it prints `Error: Invalid API key`, your key is wrong. If it hangs, your network is blocking Anthropic — try a different network.

---

**Next:** `references/04-image-providers-kie-fal.md`
