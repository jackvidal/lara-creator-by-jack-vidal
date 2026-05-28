# Phase 2 — Supabase + Prisma Database

This phase creates the Postgres database that backs everything: 16 tables, RLS enabled but Prisma-bypassed, with the exact unique constraints that prevent race-condition duplicates in the research agent.

## 2.1 Create the Supabase project

1. Sign in at https://supabase.com/dashboard
2. Click **New project**
3. Settings:
   - **Name:** `lara-creator` (or your variant)
   - **Region:** pick the one nearest to your users. `eu-central-1` works well for Israeli users; pick `us-west-1` for US, etc.
   - **Database password:** generate strong, save in a password manager (you'll need it for `DATABASE_URL`)
   - **Tier:** free is fine for a single-owner system; upgrade to Pro ($25/mo) only if you exceed 1GB Storage or hit connection limits
4. Wait ~2 minutes for provisioning
5. Note the **Project ref** (the random string like `vvnsramnkkfutkngysac`) — used in URLs

## 2.2 Install the Supabase MCP (recommended)

If you're building with Claude Code, install the Supabase MCP so you can run migrations and queries through the assistant:

In your project root, create `.mcp.json` (gitignored):

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest"],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "sbp_..."
      }
    }
  }
}
```

Get the access token from https://supabase.com/dashboard/account/tokens. Restart Claude Code — you should see `mcp__supabase__*` tools available. They include `apply_migration`, `execute_sql`, `list_tables`, `get_logs`, `get_advisors`, etc.

## 2.3 Wire `.env.local`

Copy `assets/env.example` to `.env.local` in the project root. Fill in:

```bash
# ─── Supabase (find these in dashboard → Project Settings → Database) ───
# pooled connection (port 6543) — used by Prisma at runtime
DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=20"

# direct connection (port 5432) — used by Prisma migrate / db push
DIRECT_URL="postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"

# service role key — used for Storage uploads (mirror)
# Project Settings → API → service_role → "Reveal" → copy
# New keys start with `sb_secret_...`; older projects show JWT-format
SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."
```

**Important:** the `&connection_limit=20` suffix on `DATABASE_URL` is required for Railway later. The in-process worker runs up to 4 parallel jobs, plus HTTP requests, plus Prisma's own pool — without it you'll hit "too many connections" errors under modest load. (Gotcha #21 in pitfalls.)

## 2.4 Drop in the Prisma schema

Copy `assets/prisma-schema.prisma` to `prisma/schema.prisma`. It contains 16 models:

| Model | Purpose |
|-------|---------|
| `User` | The single owner. Email unique, scrypt password hash |
| `Source` | (Reserved for future) custom user-defined sources beyond the 5 built-in adapters |
| `DiscoveredTopic` | Trends found by the research agent. **Unique on `(userId, title)`** — prevents race-condition dups |
| `TopicScore` | Per-run history of Haiku scoring for each topic |
| `GeneratedPost` | A post for one platform (FB/IG/LinkedIn) tied to a topic |
| `PostVersion` | Append-only history of every rewrite |
| `CreativeAsset` | Image or video tied to a post. `type` is `"image"` or `"video"` |
| `ScheduledPost` | A scheduled-for-future post. **Unique on `(postId, platform)`** — one schedule per post+platform |
| `PublishingLog` | One row per publish attempt with success/failure, external URL |
| `FeedbackEntry` | The owner's edits/comments/approvals — fuel for the learning agent |
| `AiLearningMemory` | Distilled style profile produced by the learning agent |
| `PromptTemplate` | (Reserved) custom prompt overrides per agent |
| `Job` | The queue. Status flow: `pending → running → done/failed`. |
| `AgentRun` | Per-job execution log with model, tokens, cost, duration |
| `AgentError` | Error log when handlers throw |
| `Settings` | One row per user (always the owner). Provider+model picks + Blotato accountIds |

Two unique indexes are non-obvious but critical:

- `discoveredTopics @@unique([userId, title])` — without this, two parallel research jobs would insert the same topic twice. With it, the second one hits `P2002` which the handler catches silently.
- `scheduledPosts @@unique([postId, platform], map: "scheduled_posts_post_platform_key")` — without this, two clicks on "Schedule" would create two scheduled rows. The `map:` attribute is the constraint's name in Postgres — but the Prisma `upsert` compound key uses the **field names** (`postId_platform`), not the `map:` value. (Gotcha #17.)

## 2.5 Push the schema

```bash
unset DATABASE_URL DIRECT_URL  # Windows specifically — see Gotcha #4
npm run db:push
```

If you're on the Supabase MCP, you can use `mcp__supabase__apply_migration` instead with the equivalent SQL. The advantage of `apply_migration` is idempotency: it records the migration in `_migrations` so re-running is safe.

Verify with `mcp__supabase__list_tables` (or in the Supabase dashboard → Table Editor): you should see all 16 tables under `public.*`.

## 2.6 Enable RLS on all tables (but don't write policies)

Run this SQL (via MCP `execute_sql` or the dashboard SQL editor):

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovered_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_learning_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
```

**Do NOT write policies.** The architecture is:

- Prisma connects as `postgres` (superuser via the pooled connection string) — automatically exempt from RLS
- The `anon` role (used by Supabase REST/PostgREST) has no policies — fully blocked from the tables
- Net effect: the only path into these tables is through your Next.js server actions, which already authenticated the owner

This is the simplest secure pattern for a single-owner system. It's NOT a generic multi-user pattern — for that you'd write real policies. If you need multi-tenancy, use `hebrew-saas-starter-by-jack-vidal` instead.

## 2.7 Create the Storage bucket for image/video mirror

The system mirrors all Kie/FAL output to Supabase Storage because their CDN URLs expire (7-30 days). For a scheduled post to still work in 6 weeks, the URL has to be stable. Create the bucket:

In dashboard → Storage → New bucket:
- **Name:** `creative-assets`
- **Public:** YES (publicly readable — the URLs need to be embeddable in posts)
- **File size limit:** 100 MB (videos can be 15-30 MB)
- **Allowed MIME types:** `image/*, video/*`

Or via SQL:

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'creative-assets',
  'creative-assets',
  true,
  104857600,                                      -- 100 MB
  ARRAY['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime']
);
```

## 2.8 Create the User row for the owner

You haven't built auth yet — that's Phase 8. But you can pre-seed the row so step-by-step verification later works:

```sql
INSERT INTO users (id, email, created_at, updated_at)
VALUES (gen_random_uuid(), '<OWNER_EMAIL>', NOW(), NOW())
RETURNING id;
```

Note the returned `id` — you'll use it later for ad-hoc verification.

Or skip this — Phase 8's `loginAction` will auto-create the User row on first setup.

## 2.9 Verify

Add a quick verification script `scripts/verify-supabase.mjs`:

```js
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();
const tables = await prisma.$queryRaw`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name;
`;
console.log("Tables:", tables.map(t => t.table_name).join(", "));
console.log("OK — Supabase is reachable.");
await prisma.$disconnect();
```

Run:
```bash
unset DATABASE_URL DIRECT_URL
npx dotenv -e .env.local -- node scripts/verify-supabase.mjs
```

Should print all 16 table names. If not, check `DATABASE_URL` is the **pooled** (6543) URL with `?pgbouncer=true&connection_limit=20` and `DIRECT_URL` is the **direct** (5432) URL.

---

**Next:** `references/03-anthropic-claude.md`
