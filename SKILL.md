---
name: lara-creator-by-jack-vidal
description: Build a clone of the Lara Creator system — a Hebrew RTL single-owner multi-agent SaaS for AI-driven content automation. Stack is Next.js 16 (App Router) + TypeScript + Tailwind v3 + Prisma 6 + Supabase Postgres with RLS + Anthropic Claude (Opus 4.7 + Haiku 4.5) + Kie.ai / Fal.ai image+video providers + optional Blotato for FB/IG/LinkedIn publishing, deployed to Railway with an in-process queue worker (not Vercel). Trigger this skill whenever the user wants to duplicate Lara Creator or Meirav's system, build a similar Hebrew/RTL content-automation SaaS, scaffold a multi-agent (research → content → review → creative → publishing → learning) pipeline, set up a single-owner system that discovers trends from real sources (Hacker News / Reddit / Product Hunt / YouTube / RSS) and posts to social media, or wire Next.js 16 + Supabase + Anthropic + Kie/FAL + Railway with an in-process queue worker. Trigger generously — even when the user only says "build the Lara system", "clone lara creator", "מערכת כמו של לארה", "מערכת לארה קריאייטור", "Hebrew AI content SaaS like Meirav's", "multi-agent SaaS with Kie.ai", or "Railway in-process worker queue with Next.js" — because the patterns here (RLS bypass via Prisma, orphan-job recovery, in-process worker on globalThis Symbol, Blotato nested body shape, Kie polling for Seedance video, Supabase Storage mirror with `apikey` header, Hebrew translation inline in Haiku scoring) are non-obvious and easy to get wrong from scratch.
---

# Lara Creator — Build Guide

This skill walks you through cloning **Lara Creator** — a production-grade Hebrew RTL multi-agent SaaS — end to end. Following the steps in order avoids the 18+ real bugs documented during the original build.

The end result: a Next.js 16 app where a **single owner** (you choose the email) logs in with a password, the system discovers AI-creative trends from 5 real sources, Claude Haiku scores and translates them to Hebrew, Claude Opus writes 3 posts per topic (FB + IG + LinkedIn), Kie.ai or Fal.ai generates an image or video for each, the owner approves/edits/schedules in a drag-and-drop calendar, and Blotato fans out to the real social platforms. Everything runs on Railway with an in-process queue worker (no Vercel — the 60s function cap kills long video generations).

---

## When this skill applies

- "Clone the Lara Creator system" / "מערכת לארה" / "Meirav's system" / "Lara Creator copy"
- "Build a Hebrew RTL multi-agent content SaaS"
- "Build a system like Lara that discovers trends and writes Hebrew posts"
- "Multi-agent content automation with Claude + Kie.ai / Fal.ai"
- "Next.js 16 + Supabase + Anthropic + Railway in-process worker"
- "Single-owner SaaS with scrypt password + HMAC cookie session"
- "Hebrew translation pipeline using Claude Haiku tool_use"
- "Blotato FB+IG+LinkedIn publishing integration"

If the user wants a **different** kind of Hebrew SaaS (e.g. a CRM, booking app, generic dashboard), use the **`hebrew-saas-starter-by-jack-vidal`** skill instead — that's the general-purpose starter. This skill is specifically for the content-automation multi-agent system.

---

## The high-level flow

Work through these phases **in order**. Each one has a dedicated reference file with the exact code, env vars, gotchas, and verification steps. Read the reference file before you start each phase.

| # | Phase | Reference file |
|---|-------|----------------|
| 1 | Scaffold the Next.js 16 + TypeScript + Tailwind v3 project with the exact dependency set | `references/01-project-setup.md` |
| 2 | Create the Supabase project, define the 16-table Prisma schema, enable RLS (and bypass via Prisma) | `references/02-supabase-database.md` |
| 3 | Wire the Anthropic Claude client — Opus 4.7 for content/review, Haiku 4.5 for scoring — with `cache_control` + structured `tool_use` output | `references/03-anthropic-claude.md` |
| 4 | Wire the Kie.ai + Fal.ai image+video providers behind a single abstraction with createTask/polling | `references/04-image-providers-kie-fal.md` |
| 5 | (Optional) Wire Blotato for real publishing to FB, IG, LinkedIn — with the nested `{post:{content,target}}` body shape | `references/05-blotato-publishing.md` |
| 6 | Build the 7-agent system (research, content, content-rewrite, review, creative, publishing, learning) + database-backed queue + dispatcher with orphan-job recovery | `references/06-multi-agent-system.md` |
| 7 | Build the 5 source adapters (Hacker News, Reddit, Product Hunt, YouTube, RSS) for the research agent | `references/07-source-adapters.md` |
| 8 | Single-owner auth: scrypt password hash + HMAC cookie session bound to `OWNER_EMAIL` | `references/08-single-owner-auth.md` |
| 9 | Deploy to Railway with a Dockerfile, in-process queue worker via `src/instrumentation.ts`, `/api/health` for the probe, and Namecheap DNS cutover | `references/09-railway-deployment.md` |
| 10 | The full gotchas list — read this **before** starting, then again whenever something breaks | `references/10-gotchas-and-pitfalls.md` |
| 11 | Smoke tests to verify the live system works end-to-end | `references/11-smoke-tests-and-verification.md` |

---

## Files in `assets/`

| File | Purpose |
|------|---------|
| `assets/env.example` | The exact env var template — copy to `.env.local` |
| `assets/prisma-schema.prisma` | The full 16-model Prisma schema (Postgres + directUrl) |
| `assets/Dockerfile` | Multi-stage Alpine Dockerfile with Prisma engine binaries copied explicitly |
| `assets/next.config.ts` | Standalone output config (required for Docker) |

---

## Critical rules that apply across phases

These are the lessons learned the hard way. They override anything that contradicts them:

1. **Deploy to Railway, not Vercel.** The Lara system has a creative-generation step (Kie/FAL Seedance video) that takes **300+ seconds**. Vercel's 60-second function cap will SIGTERM your queue mid-job, leaving rows stuck in `running` forever. Railway runs a long-lived Node process with an in-process worker — no timeout, no HTTP hop, no auth header.
2. **The queue worker lives inside the Next.js process**, started by `src/instrumentation.ts`. State is held on `globalThis[Symbol.for(...)]` so it survives Next.js standalone's dual-module loading. See `references/09-railway-deployment.md`.
3. **Orphan job recovery is mandatory.** Even on Railway, redeploys SIGTERM jobs mid-flight. `claimJobs()` must reclaim rows stuck in `running` for >3 minutes before claiming new pending ones. See `references/06-multi-agent-system.md`.
4. **Prisma bypasses Supabase RLS as a postgres superuser.** Enable RLS on all 16 tables — but do NOT write policies. The `anon` role is blocked from REST entirely; Prisma connects as `postgres` and is exempt. This is the simplest secure pattern for a single-owner system.
5. **The system is single-owner.** Auth is `OWNER_EMAIL` env var + scrypt password chosen on first login + HMAC cookie session that breaks on password change. Don't add roles, don't add multi-tenancy. See `references/08-single-owner-auth.md`.
6. **Hebrew translation happens inline in Haiku scoring** — one tool_use call returns `titleHe`, `summaryHe`, and the three scores together. Don't add a separate translation step. See `references/06-multi-agent-system.md` (research section) and `references/03-anthropic-claude.md`.
7. **Blotato `POST /v2/posts` requires a nested body** — `{post:{accountId, content:{text,mediaUrls,platform}, target:{targetType, ...}}, scheduledTime?}`. A flat body returns 400 `body. must have required property 'post'`. See `references/05-blotato-publishing.md`.
8. **Supabase Storage uploads require the `apikey` header** when using the new `sb_secret_*` keys (they're not JWT). The old `Authorization: Bearer` alone returns "Invalid Compact JWS". Send both headers for compatibility. See `references/04-image-providers-kie-fal.md` (Storage mirror section).
9. **Don't trust `<img>` for video assets.** When `CreativeAsset.type === "video"` the URL is `.mp4` — render `<video>` not `<img>`, or you get a broken-image icon.
10. **Read `references/10-gotchas-and-pitfalls.md` BEFORE you start.** All 18 gotchas live there with severity, symptom, and fix.

---

## Recommended interview before you start

Before scaffolding, ask the user these short questions. They unblock concrete decisions you'd otherwise have to guess at, and reduce rework later. Use the AskUserQuestion tool when running in Claude Code.

1. **What's the owner email?** (single user who can log in) — this becomes `OWNER_EMAIL` env var
2. **What's the domain you want to use?** (production URL — e.g. `mysite.example.com`) or "skip for now"
3. **Which image provider?** (Kie.ai recommended for Nano Banana 2; Fal.ai works too — pick one as default, you can switch in Settings later)
4. **Do you want publishing right now?** (Blotato integration is optional — you can skip Phase 5 and add it later when the owner is ready to connect FB/IG/LinkedIn)
5. **What's the niche?** (image+video AI? marketing? other?) — drives which subreddits, RSS feeds, and YouTube channels go into the source adapters

For everything else (UI language, font, color system) Hebrew + Heebo + the aurora palette are baked in. If the user wants a different design language, that's a separate skill (`hebrew-saas-starter-by-jack-vidal`).

---

## Order of operations — the strict path

Don't reorder these. The original build hit pain at every step where the order was wrong.

```
Phase 1  Project scaffold              → src/, package.json, tailwind, next.config.ts
Phase 2  Supabase + Prisma schema      → 16 tables, RLS on, migrations applied
Phase 3  Anthropic client + generate   → src/lib/ai/{client,generate}.ts
Phase 4  Creative providers            → src/lib/creative/{providers,models}.ts
Phase 5  Blotato (optional)            → src/lib/publishing/blotato.ts
Phase 6  Agents + queue + dispatcher   → src/lib/{agents,queue}/* + 7 handlers
Phase 7  Source adapters               → src/lib/agents/sources/* + RSS parser
Phase 8  Auth + login flow             → src/lib/auth.ts + /login pages
Phase 9  Railway deploy                → Dockerfile, instrumentation, /api/health, DNS
```

Verify each phase works locally before moving to the next:

- After Phase 2: `npx tsx scripts/verify-supabase.mjs` (returns OK)
- After Phase 6: enqueue a research job manually, check the `agent_runs` table for a success row
- After Phase 9: `curl https://your-domain/api/health` returns `{"ok":true,"worker":{"started":true,...}}`

---

## What this skill does NOT include

- **No seed data.** The system is built for a single real owner — no `prisma/seed.ts`, no `dev.db`. The owner sees an empty dashboard until they click "Discover topics".
- **No multi-tenancy.** One owner, one Settings row, one set of Blotato accounts. Don't try to generalize.
- **No SMS / email notifications.** Out of scope.
- **No analytics dashboard or metrics export.** Only the basic Overview tab with counts.
- **No CMS.** All content lives in Postgres tables; the owner edits in the dashboard.

If the user wants any of these, treat them as separate post-MVP work — don't bake them into the initial build.

---

Start with **Phase 1** (`references/01-project-setup.md`) and proceed top to bottom.
