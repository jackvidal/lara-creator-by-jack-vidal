# 10 — The Gotchas List (read before you build)

These are the 18+ specific bugs hit during the original Lara Creator build. Read this whole file once before Phase 1, then re-read whenever something is broken in production. Each one is a real bug we lost hours to.

| # | Severity | Symptom | Root cause + fix |
|---|----------|---------|------------------|
| 1 | High | Vercel `vercel env add KEY env < file` results in `KEY=""` on Windows | The pipe / `<` redirect is broken on Windows. **Don't use it.** Use Vercel REST API direct: `POST https://api.vercel.com/v10/projects/{id}/env?teamId={teamId}` with `Authorization: Bearer <token from %APPDATA%\xdg.data\com.vercel.cli\auth.json>` and JSON body `{key,value,type:"encrypted",target:["production"]}`. Only relevant if rolling back to Vercel — Railway is preferred. |
| 2 | High | `vercel project add` deploy fails with "No Output Directory named public" | Vercel doesn't auto-detect Next.js. Add `vercel.json` with `"framework": "nextjs"`. (Vercel only — Railway uses the Dockerfile and is unaffected.) |
| 3 | Medium | Vercel/Railway build succeeds but runtime crashes with "PrismaClient not initialized" | Cached `node_modules` skipped `postinstall`. Always have `"build": "prisma generate && next build"` AND `"postinstall": "prisma generate"`. Belt and suspenders. |
| 4 | High | Local `npm run dev` ignores `.env.local` — keys show as undefined | Stale empty env vars in your Windows shell silently override `.env.local`. Before every dev session: `unset DATABASE_URL DIRECT_URL ANTHROPIC_API_KEY FAL_API_KEY KIE_API_KEY BLOTATO_API_KEY OWNER_EMAIL SUPABASE_SERVICE_ROLE_KEY 2>/dev/null`. |
| 5 | High | `npx prisma generate` fails with EBUSY/EPERM on Windows | The dev server holds a lock on the Prisma engine DLL. Kill port 3000 first: `Get-NetTCPConnection -LocalPort 3000 \| Stop-Process -Force`. |
| 6 | High | FAL Seedance model returns "COMPLETED" but response 404s | You used the `fal-ai/` prefix. ByteDance Seedance on FAL uses **bare vendor path**: `bytedance/seedance-2.0/text-to-video`. Other model families do use `fal-ai/`. Check fal.ai/models before assuming. |
| 7 | Medium | Kie rejects `aspect_ratio: "1.91:1"` with "not within range of allowed options" | LinkedIn's spec is 1.91:1 but Kie's accepted list doesn't include it. Use `"16:9"` for LinkedIn (both image and video). Visual difference is ~48px height — invisible in feed. |
| 8 | Critical | `vercel.com` shows "Build successful" but the new code isn't live | Vercel's GitHub auto-deploy silently fails for many private repos. **Always run `vercel deploy --prod --yes` manually after a push.** Or — better — migrate to Railway, where push-to-deploy actually works. |
| 9 | Medium | Supabase `cron.job` UPDATE returns "permission denied for table job" | Supabase restricts direct UPDATE on the `cron.job` table even via the SQL editor. Use functions: `SELECT cron.alter_job(job_id := 1, active := false);`. Same for `cron.schedule`/`cron.unschedule`. (Only relevant if you set up pg_cron — which you shouldn't on Railway.) |
| 10 | High | `/api/health` reports `started: false` even though the worker is logging ticks | Next.js standalone duplicates modules: instrumentation context and route handler context each have their own module instance. Fix: hold worker state on `globalThis[Symbol.for("project.worker.state")]`. See `references/09-railway-deployment.md` §9.4. |
| 11 | Critical | `/publishing` page returns 500 with only "An error occurred" — message hidden | A server component imported a value from a `"use client"` module. Next.js 16 turns all exports of a `"use client"` module into client references — server-render crashes silently. **Fix:** extract pure helpers (functions, constants, types) to a neutral module without any directive, import that from both sides. See `src/components/publishing/platform-meta.ts` pattern. |
| 12 | Medium | Next.js production error.tsx shows only digest, message is sanitized to "An error occurred in the Server Components render. The specific message is omitted in production builds..." | This is by design. To see the real message in production, wrap the suspect code in `try/catch` and render the error.message + stack as **JSX content** (not via `throw`). Content passes the sanitizer. Add a `DiagnosticBanner` component to the suspect page, deploy, watch it, then remove. |
| 13 | Medium | `/creative` page shows broken-image icon for video assets | `<img src=...>` doesn't render mp4. Choose the tag by `asset.type`: `<video controls muted playsInline preload="metadata">` for video, `<img>` for image, placeholder `<div>` for null. |
| 14 | Critical | Blotato `POST /v2/posts` returns 400 `body. must have required property 'post'` on every call | The body must be nested: `{post:{accountId, content:{text,mediaUrls,platform}, target:{targetType,...}}, scheduledTime?}`. **Not** flat `{accountId, platform, text, mediaUrls, ...}`. See `references/05-blotato-publishing.md` §5.4. |
| 15 | Critical | Blotato `createPost` returns 500 "Account NNNNN not found" — was working yesterday | Owner reconnected a platform in Blotato → new accountId. Your DB has the old one. **Add a "Sync with Blotato" button** in Settings that calls `listAccounts()` and updates the 5 ID fields. Tell the owner to click it whenever they reconnect. Optionally auto-sync on every Settings page load. |
| 16 | Low | A post stuck in `status='publishing'` with `blotatoSubmissionId` filled but no published log | Blotato returned a `status` value not in your typed enum. Add `"success"`/`"completed"`/etc. to your mapping, or poll `getPostStatus` after 3-5s when the create response is inconclusive. |
| 17 | Medium | Prisma `upsert` on `scheduled_posts` with `postId_platform` compound key fails with "no field with that name" | The compound key name in Prisma is built from the **field names** (`postId_platform`), not the `map:` attribute (which only affects the constraint name in Postgres). Use `{ postId_platform: { postId, platform } }` in the upsert. |
| 18 | High | Claude Haiku returns `tool_use` block with `scores` field undefined → handler crashes on `.find()` | `maxTokens` was too small — Haiku truncated output mid-stream. For a 20-item array with structured items including translation + 3 scores + idea + rationale, budget **~250 tokens per item** = `maxTokens: 6000`. Also add defensive guard: `if (!Array.isArray(result.data?.scores) \|\| !result.data.scores.length) fallback`. |
| 19 | High | Owner clicks "Approve topic", UI freezes for 5-10 minutes, can't switch tabs | Server action `await drain()`-ed the queue. **Don't.** Enqueue and return immediately — the in-process worker (Phase 9) drains within ~15s. Toast: "Approved — posts will appear in 2-3 minutes." The only action that should `await drain()` is `runQueueAction` ("Run engine" button). |
| 20 | Critical | Jobs stuck in `status='running'` forever after a deploy / OOM / SIGTERM | `claimJobs` only sees `pending` rows; `running` rows are invisible. **Add `reclaimOrphanJobs(tx)`** that finds `running` rows with `startedAt < NOW - 3min` and resets them to `pending`. Run inside the same transaction as the claim. See `references/06-multi-agent-system.md` §6.4. |
| 21 | Medium | Worker hits "too many connections" under modest load | Default Prisma pool + 4 parallel jobs + HTTP requests can exceed Supabase's default connection cap. **Append `&connection_limit=20` to `DATABASE_URL`.** This caps Prisma's pool at 20 — fits comfortably under Supabase's limit. |
| 22 | Low | Hebrew translation pipeline produces "קולטורה" instead of "תרבות", or bleeds Japanese/Chinese characters in | Haiku 4.5 is 95% good at Hebrew but makes aesthetic errors. SYSTEM prompt should explicitly forbid Japanese/Chinese/Russian/Arabic words and give 5 before/after translation examples (passive vs active voice). For perfection, upgrade `MODELS.fast` from Haiku to Sonnet — ×15 cost (~$0.015 → $0.225/run). Worth it only if owner complains. |
| 23 | Medium | Score-to-candidate mapping by title returns undefined → falls back to mockScore for everything → English titles displayed | Claude truncates long titles, uses different Unicode quotes (U+2019 vs U+0027), or swaps translation into wrong field. **Fix:** prepend `[index=N]` to each candidate in the user prompt, require the same N back in each score object, match by integer. Bulletproof. See `references/06-multi-agent-system.md` §6.8. |
| 24 | Medium | YouTube adapter returns 4× 404 — only 1 of 5 channel IDs works | YouTube channel IDs aren't the same as `@handles`. **To get the ID:** open `youtube.com/@<handle>`, view source, grep `"channelId":"UC...` (24 chars starting with UC). The original spec's IDs were wrong for 4/5 channels. Re-verify before relying. |
| 25 | Medium | Supabase Storage upload fails with "Invalid Compact JWS" | New Supabase keys (`sb_secret_*`) are not JWT. Storage rejects them when sent via `Authorization: Bearer` alone. **Send BOTH headers:** `apikey: <key>` and `Authorization: Bearer <key>`. This works for old (JWT) AND new (`sb_secret_*`) keys. |
| 26 | Low | Server-side actions that should be `void` accidentally return `{processed: 0}` after dropping `drain()` | When you remove `await drain()`, also drop the return shape since callers no longer get a count. Make actions void, return a stable `revalidatePath()`. Toast UI tells the user what's happening instead. |
| 27 | Low | When the owner reconnects a Blotato platform, `Settings.blotato_*_page_id` is NULL but FB requires it | FB `createPost` mandates `pageId`. The Sync flow needs to surface `subaccounts` (Pages) and ask the owner which Page to post from. Don't silently default — wrong Page = post goes to wrong audience. |
| 35 | High | Image uploads work, video uploads (or any FormData upload >1MB) fail with a generic error | Next.js Server Actions default body size limit is **1 MB**. Add to `next.config.ts`: `experimental: { serverActions: { bodySizeLimit: "150mb" } }`. The Server Action throws "Body exceeded 1 MB limit" BEFORE your action code runs, so the validation logic inside looks fine in code review. Applies to any FormData upload (Phase 12 style-references, future direct media uploads, large CSV imports). |

## How to use this list while building

- **Phase 1-2 (setup):** rows 1, 2, 3, 4 apply
- **Phase 3 (Anthropic):** row 18 applies
- **Phase 4 (Kie/FAL):** rows 6, 7, 25 apply
- **Phase 5 (Blotato):** rows 14, 15, 16, 27 apply
- **Phase 6 (agents):** rows 17, 18, 19, 20, 22, 23 apply
- **Phase 7 (sources):** row 24 applies
- **Phase 9 (Railway):** rows 8, 10, 21 apply
- **UI work:** rows 11, 12, 13 apply

## How to add a new gotcha as you find them

When you hit a new one:
1. Add a numbered row above (severity, symptom, root cause, fix).
2. Cross-reference the Phase where it bites.
3. If the fix is structural, also update the corresponding phase's reference doc with the fix detail.
4. Commit the gotchas update **before** the source fix — so the next person sees the warning even if they ignore the doc.

---

**Next:** `references/11-smoke-tests-and-verification.md`
