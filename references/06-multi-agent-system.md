# Phase 6 — Multi-Agent System + Queue + Dispatcher

The core engine: 7 agent handlers, a Postgres-backed job queue, a dispatcher with orphan-recovery, and a registry that maps job types to handlers. Everything lives in `src/lib/agents/` and `src/lib/queue/`.

## 6.1 The agents — what each does

| Agent | Job type(s) | Model | Triggered by |
|-------|-------------|-------|--------------|
| **research** | `research.discover` | Haiku 4.5 | "Discover topics" button, or cron |
| **content** | `content.generate` | Opus 4.7 | Owner approves a topic |
| **content-rewrite** | `content.rewrite` | Opus 4.7 | Owner clicks "Apply suggestions & rewrite" |
| **review** | `review.evaluate` | Opus 4.7 | After content/rewrite — auto-enqueued |
| **creative** | `creative.generate` | (no LLM) | After content — auto-enqueued. Calls Kie/FAL provider. |
| **publishing** | `publish.execute` | (no LLM) | Cron: when a `ScheduledPost.scheduledAt` is due |
| **learning** | `learning.distill` | Opus 4.7 | "Run learning" button, or cron |

A typical owner click ("Approve topic") fans out: one `content.generate` job → produces 3 posts (FB+IG+LinkedIn) → each post enqueues `review.evaluate` + `creative.generate`. That's 7 jobs from one click, all running through the queue.

## 6.2 The job lifecycle

Each row in the `jobs` table is one unit of work:

```
status: pending → running → done   (happy path)
                         → failed  (after maxAttempts exhausted)
                         → pending (retry with exponential backoff)
```

`startedAt` is set when claimed. `finishedAt` when done/failed. `attempts` is incremented on each failure. `runAfter` is the earliest time the job can be claimed (used for backoff).

## 6.3 The queue — `src/lib/queue/queue.ts`

```ts
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toJson } from "@/lib/json";

const ORPHAN_THRESHOLD_MS = 3 * 60 * 1000;   // 3 min

export async function enqueue(opts: {
  userId: string;
  type: string;
  agent: string;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: Date;
}): Promise<Job> {
  return prisma.job.create({
    data: {
      userId: opts.userId,
      type:   opts.type,
      agent:  opts.agent,
      payload: toJson(opts.payload ?? {}),
      priority: opts.priority ?? 0,
      runAfter: opts.runAfter ?? new Date(),
    },
  });
}

export async function claimJobs(limit: number): Promise<{ jobs: Job[], reclaimed: number }> {
  return prisma.$transaction(async (tx) => {
    // STEP 1: orphan recovery — reclaim `running` rows older than 3 min
    const reclaimed = await reclaimOrphanJobs(tx);

    // STEP 2: claim up to `limit` pending jobs ready to run
    const jobs = await tx.job.findMany({
      where:   { status: "pending", runAfter: { lte: new Date() } },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take:    limit,
    });
    if (jobs.length === 0) return { jobs: [], reclaimed };
    await tx.job.updateMany({
      where: { id: { in: jobs.map(j => j.id) } },
      data:  { status: "running", startedAt: new Date() },
    });
    return { jobs: jobs.map(j => ({ ...j, status: "running" })), reclaimed };
  });
}
```

## 6.4 Orphan recovery — the must-have

When a container is killed mid-job (Railway redeploy, OOM, SIGTERM), the row stays `status='running'` forever. Without recovery, `claimJobs` never sees it as pending, so it's stuck.

```ts
export async function reclaimOrphanJobs(tx: typeof prisma): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS);
  const orphans = await tx.job.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    take: 50,
  });
  for (const o of orphans) {
    const attempts = o.attempts + 1;
    const exhausted = attempts >= o.maxAttempts;
    await tx.job.update({
      where: { id: o.id },
      data: {
        status:     exhausted ? "failed" : "pending",
        attempts,
        error:      `Orphan recovery — sat in 'running' >3 min`,
        startedAt:  null,
        finishedAt: exhausted ? new Date() : null,
        runAfter:   new Date(),
      },
    });
    // BONUS: if this was a creative.generate that exhausted attempts, mark the
    // CreativeAsset row 'failed' too so the UI doesn't show a stuck spinner.
    if (exhausted && o.type === "creative.generate") {
      const payload = JSON.parse(o.payload);
      if (payload.postId) {
        await tx.creativeAsset.updateMany({
          where: { postId: payload.postId, type: payload.media ?? "image", status: "generating" },
          data:  { status: "failed", meta: JSON.stringify({ error: "Job timed out" }) },
        });
      }
    }
  }
  return orphans.length;
}
```

The 3-minute threshold is tuned: it has to be longer than the slowest legitimate job (a Kie video generation is ~5min total but checkpoints) but short enough that owner-visible failures don't stuck for hours. (Gotcha #20.)

## 6.5 The dispatcher — `src/lib/queue/dispatcher.ts`

```ts
import { prisma } from "@/lib/prisma";
import { toJson } from "@/lib/json";
import { getHandler } from "@/lib/agents/registry";
import { claimJobs, enqueue, enqueueDueScheduledPosts } from "./queue";

const BACKOFF_MS = [60_000, 300_000, 900_000];  // 1m, 5m, 15m

export async function tick(limit = 5): Promise<TickResult> {
  const { jobs, reclaimed } = await claimJobs(limit);
  let processed = 0, failed = 0;

  for (const job of jobs) {
    const handler = getHandler(job.type);
    const startedAt = Date.now();
    if (!handler) {
      await prisma.job.update({ where: { id: job.id },
        data: { status: "failed", error: `No handler for ${job.type}`, finishedAt: new Date() } });
      failed++; continue;
    }

    try {
      const result = await handler(job);
      await prisma.job.update({ where: { id: job.id },
        data: { status: "done", finishedAt: new Date(), result: toJson(result.result ?? null), error: null } });
      await prisma.agentRun.create({ data: {
        userId: job.userId, jobId: job.id, agent: job.agent,
        status: "success", durationMs: Date.now() - startedAt,
        model: result.usage?.model ?? null,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        costUsd: result.usage?.costUsd ?? 0,
        summary: result.summary,
      }});
      // chain agent-to-agent follow-ups
      for (const f of result.followUps ?? []) {
        await enqueue({ userId: job.userId, type: f.type, agent: f.agent, payload: f.payload });
      }
      processed++;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const attempts = job.attempts + 1;
      const willRetry = attempts < job.maxAttempts;
      const backoff = BACKOFF_MS[attempts - 1] ?? 900_000;
      await prisma.job.update({ where: { id: job.id }, data: {
        status:    willRetry ? "pending" : "failed",
        attempts,
        error:     err.message,
        runAfter:  new Date(Date.now() + backoff),
        finishedAt: willRetry ? null : new Date(),
      }});
      await prisma.agentError.create({ data: {
        userId: job.userId, jobId: job.id, agent: job.agent,
        message: err.message, stack: err.stack ?? null, attempt: attempts,
      }});
      await prisma.agentRun.create({ data: {
        userId: job.userId, jobId: job.id, agent: job.agent,
        status: "failed", durationMs: Date.now() - startedAt,
        summary: willRetry ? `Failed (attempt ${attempts}) — will retry` : `Failed permanently: ${err.message}`,
      }});
      failed++;
    }
  }
  return { processed, failed, reclaimed };
}
```

And the high-level `drain()` for "process everything that's pending":

```ts
export async function drain(opts: { maxWaves?: number; tickLimit?: number; budgetMs?: number } = {}) {
  const maxWaves = opts.maxWaves ?? 8;
  const tickLimit = opts.tickLimit ?? 8;
  const deadline = opts.budgetMs != null ? Date.now() + opts.budgetMs : Infinity;

  let processed = 0, failed = 0, reclaimed = 0;
  await enqueueDueScheduledPosts();  // pull in any scheduled-post jobs that are due

  for (let wave = 0; wave < maxWaves; wave++) {
    if (Date.now() >= deadline) break;
    const r = await tick(tickLimit);
    processed += r.processed; failed += r.failed; reclaimed += r.reclaimed;
    if (r.processed === 0 && r.failed === 0 && r.reclaimed === 0) break;
  }
  return { processed, failed, reclaimed };
}
```

## 6.6 The registry — `src/lib/agents/registry.ts`

```ts
import { researchHandler }        from "./research";
import { contentHandler, contentRewriteHandler } from "./content";
import { creativeHandler }        from "./creative";
import { reviewHandler }          from "./review";
import { publishingHandler }      from "./publishing";
import { learningHandler }        from "./learning";

const handlers = {
  "research.discover":  researchHandler,
  "content.generate":   contentHandler,
  "content.rewrite":    contentRewriteHandler,
  "creative.generate":  creativeHandler,
  "review.evaluate":    reviewHandler,
  "publish.execute":    publishingHandler,
  "learning.distill":   learningHandler,
};

export function getHandler(type: string) { return handlers[type as keyof typeof handlers]; }
```

## 6.7 Handler contract

Each handler implements:

```ts
type JobHandler = (job: Job) => Promise<{
  summary: string;
  result?: unknown;
  followUps?: { type: string; agent: string; payload?: any }[];
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
}>;
```

The dispatcher logs `summary` to `agent_runs` (visible in the Overview tab activity feed) and chains `followUps` through `enqueue`. The dispatcher catches any throw and converts it to a failure with retry backoff.

## 6.8 Research handler — Hebrew translation inline

The research handler is the most complex. Key features:

1. Fetches trends from 5 source adapters (Phase 7) via `fetchAllSources()`.
2. Dedupes by `sourceUrl` against existing `DiscoveredTopic` rows.
3. Takes the top `HAIKU_CANDIDATE_POOL = 20` candidates after shuffle (so one source doesn't dominate).
4. Sends ALL 20 to Haiku in one call with a structured tool_use schema that returns `index + titleHe + summaryHe + 3 scores + postIdea + rationale` per item.
5. **Filters to MIN_RELEVANCE = 50** — anything below is "noise" (LLM research, coding tools, AGI philosophy) and dropped.
6. Picks **top 4 by composite score** (`relevance×0.5 + trend×0.3 + virality×0.2`).
7. Saves to DB. Race-tolerant: catches Prisma `P2002` (unique violation on `(userId, title)`) and skips silently.

**Index-based mapping is critical.** Earlier versions matched by title, but Claude sometimes:
- Truncates long titles in the response
- Returns Unicode quote variants (U+2019 vs U+0027)
- Swaps the Hebrew translation into the English title field

Result: `scores.find(s => s.title === candidate.title)` returns undefined → fallback to mockScore → 75% of trends end up English. (Gotcha — see "score-to-candidate mapping" in research.ts comments.)

**Fix:** prepend `[index=N]` to each candidate in the user prompt, require Claude to return the same `index` in each score object, match by integer. Bulletproof.

```ts
userPrompt: `User interests: ${interests.join(", ")}.

Score the following topics. Each item starts with [index=N] — return the same N in the score's index field.

${candidates.map((c, i) =>
  `[index=${i}]\nTitle: ${c.title}\nSummary: ${c.summary}\nTags: ${c.tags.join(", ")}`
).join("\n\n")}`,
```

And in the schema:

```ts
properties: {
  scores: {
    type: "array",
    items: {
      type: "object",
      properties: {
        index:        { type: "integer", minimum: 0, description: "The [index=N] number from the original — return exactly that." },
        titleHe:      { type: "string", description: "Hebrew title (≤80 chars). Product names stay in English." },
        summaryHe:    { type: "string", description: "Hebrew summary (≤200 chars)." },
        trendScore:    { type: "integer", minimum: 0, maximum: 100 },
        relevanceScore:{ type: "integer", minimum: 0, maximum: 100 },
        viralityScore: { type: "integer", minimum: 0, maximum: 100 },
        postIdea:      { type: "string" },
        rationale:     { type: "string" },
      },
      required: ["index","titleHe","summaryHe","trendScore","relevanceScore","viralityScore","postIdea","rationale"],
    },
  },
},
maxTokens: 6000,    // 20 items × ~250 tok/item with safety margin
```

For the system prompt itself, see the actual `research.ts` in the source. Key principles:
- Bilingual translation rules (active voice not passive, product names in English, no Japanese/Chinese/Russian/Arabic words bleeding in)
- relevance scoring scale (80-100 = core creative AI, 50-79 = adjacent, 0-49 = noise)
- 5+ examples of good translation

The system prompt is ~3000 tokens — caching gives ~70% savings on subsequent runs within 5 min.

## 6.9 Content + creative + review handlers

These are simpler than research:

- **content.generate:** load topic, build a `styleContext` from `Settings` + `AiLearningMemory` + recent feedback. One Opus call returns 3 posts (FB/IG/LinkedIn) with the right tone/length per platform. Saves a row per post + a `PostVersion` row per post. Enqueues `review.evaluate` + `creative.generate` per post.
- **creative.generate:** load post, pick provider (Kie/FAL based on Settings), create a `CreativeAsset` placeholder row with `status: 'generating'` BEFORE calling `provider.generate()` — so if Railway SIGTERMs mid-generation, the orphan recovery can clean it up. After success, mirror to Supabase Storage (Phase 4), update the asset with `publicUrl`, status `'ready'`.
- **review.evaluate:** Opus call that scores the post (0-100) and produces concrete improvement suggestions stored as `review_notes` JSON. Owner can choose to "Apply & rewrite" → enqueues `content.rewrite` with the suggestions in payload.
- **content.rewrite:** loads the post, the suggestions, and the style context, asks Opus for a revised version. Saves a new PostVersion, updates the post content, enqueues a fresh `review.evaluate` so the rewrite gets re-scored.
- **publish.execute:** loads the ScheduledPost, builds the Blotato CreatePostInput from the latest CreativeAsset's `publicUrl`, calls `createPost`. Writes `blotato_submission_id` back for idempotency. (See Phase 5 for the body shape.)
- **learning.distill:** loads recent FeedbackEntry rows, asks Opus to distill them into a style profile (tone, voice patterns, do's and don'ts). Saves a new `AiLearningMemory` row, deactivates the previous one. Future content calls use this as the `styleContext`.

## 6.10 Async-first server actions

Server actions that enqueue jobs **should not await `drain()`**. The original Vercel build did, which blocked the UI for 5-10 minutes while jobs ran. (Gotcha #19.)

Pattern:

```ts
// CORRECT — fire and forget
export async function approveTopicAction(topicId: string) {
  const user = await requireUser();
  await prisma.discoveredTopic.update({ where: { id: topicId }, data: { status: "approved" } });
  await enqueue({ userId: user.id, type: "content.generate", agent: "content", payload: { topicId } });
  // Worker picks it up within 15s.
  revalidatePath("/topics");
}

// WRONG — blocks UI for minutes
export async function approveTopicAction(topicId: string) {
  await enqueue(...);
  await drain();    // ← don't do this
}
```

The owner gets a toast: "Approved — posts will appear in 2-3 minutes." The worker (Phase 9) processes the queue silently in the background.

The exception is `runQueueAction` ("Run engine" button) — that one deliberately awaits `drain()` because the owner explicitly asked to flush the queue.

---

**Next:** `references/07-source-adapters.md`
