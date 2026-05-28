# 11 — Smoke Tests and Verification

After Railway deploy, run through these in order. They cover the most common failure modes.

## Test 1 — Healthcheck returns 200 with `started: true`

```bash
curl -s "https://your-domain/api/health" | jq
```

Expected:

```json
{
  "ok": true,
  "worker": { "started": true, "lastTickAt": "...", "tickAgeMs": <60000, "stale": false },
  "uptime": 142
}
```

If `started: false` — instrumentation didn't fire. Check Railway logs for `[worker] starting` line.
If `ok: false, stale: true` — worker hung. Restart the service.
If 404 — health route didn't deploy. Check `src/app/api/health/route.ts` is present and the build succeeded.

## Test 2 — Login page renders

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://your-domain/login"
```

Expected: `HTTP 200`. If 500, check Railway logs for stack trace.

## Test 3 — Source adapters reachable (local)

From your dev machine:

```bash
unset DATABASE_URL DIRECT_URL ANTHROPIC_API_KEY FAL_API_KEY KIE_API_KEY BLOTATO_API_KEY OWNER_EMAIL SUPABASE_SERVICE_ROLE_KEY 2>/dev/null
npx tsx scripts/probe-sources.mjs
```

Expected output:

```
[sources] hackernews: N trends in <2000ms
[sources] reddit: N trends in <3000ms
[sources] producthunt: N trends in <2000ms
[sources] youtube: N trends in <2000ms
[sources] rss: N trends in <5000ms
Total: 30-80 unique trends
```

A source returning 0 means its URL is stale or it's rate-limited from your IP. Fix the source or comment it out for now.

## Test 4 — Enqueue a research job manually via MCP

If you have the Supabase MCP installed:

```sql
-- Get your user id first:
SELECT id, email FROM users WHERE email = '<OWNER_EMAIL>';

-- Enqueue:
INSERT INTO jobs (id, user_id, type, agent, payload, status, priority, attempts, max_attempts, run_after, created_at)
VALUES (gen_random_uuid()::text, '<USER_ID>', 'research.discover', 'research', '{}', 'pending', 0, 0, 3, NOW(), NOW())
RETURNING id;
```

Wait ~30 seconds. Then:

```sql
SELECT id, status, error, result FROM jobs WHERE id = '<JOB_ID>';
```

Expected: `status='done'`, `result` includes `discovered: N` (where N ≥ 1 if at least one source returned something creative).

Check `discovered_topics`:

```sql
SELECT source_name, count(*) FROM discovered_topics
WHERE discovered_at > NOW() - INTERVAL '5 min'
GROUP BY source_name;
```

Expected: rows from at least 2-3 sources.

## Test 5 — Worker reclaims orphans

To simulate the orphan recovery path:

```sql
-- Create an artificial orphan
INSERT INTO jobs (id, user_id, type, agent, payload, status, priority, attempts, max_attempts, run_after, created_at, started_at)
VALUES (
  gen_random_uuid()::text, '<USER_ID>',
  'research.discover', 'research', '{}',
  'running',  -- key: 'running'
  0, 0, 3,
  NOW(), NOW(),
  NOW() - INTERVAL '5 min'  -- key: started_at > 3min ago
);
```

Wait one worker tick cycle (~15s). Then check:

```sql
SELECT status, error FROM jobs WHERE started_at < NOW() - INTERVAL '4 min';
```

The artificial orphan should now be `status='pending'` again (or `'failed'` if attempts exhausted) with error mentioning "Orphan recovery".

## Test 6 — Image generation end-to-end

Approve a discovered topic via the UI (or programmatically):

```sql
UPDATE discovered_topics SET status = 'approved' WHERE id = '<TOPIC_ID>';

INSERT INTO jobs (id, user_id, type, agent, payload, status, priority, attempts, max_attempts, run_after, created_at)
VALUES (gen_random_uuid()::text, '<USER_ID>', 'content.generate', 'content',
  json_build_object('topicId', '<TOPIC_ID>')::text,
  'pending', 0, 0, 3, NOW(), NOW());
```

Wait 60-120s (Opus content + Kie/FAL creative). Then:

```sql
-- 3 posts should exist (FB, IG, LinkedIn)
SELECT id, platform, status FROM generated_posts WHERE topic_id = '<TOPIC_ID>';

-- Each should have an asset
SELECT p.platform, a.type, a.status, a.public_url
FROM generated_posts p
LEFT JOIN creative_assets a ON a.related_post_id = p.id
WHERE p.topic_id = '<TOPIC_ID>';
```

Expected:
- 3 `generated_posts` rows (`status='reviewed'` after the review handler runs)
- 3 `creative_assets` rows (`status='ready'`, `public_url` populated, type='image')
- The `public_url` should be a Supabase Storage URL (`https://<ref>.supabase.co/storage/v1/object/public/creative-assets/<userId>/<id>.png`)

If `public_url` is NULL but `image_url` has the Kie/FAL CDN URL — the storage mirror failed. Check `SUPABASE_SERVICE_ROLE_KEY` is set in Railway. (Gotcha #25.)

## Test 7 — Blotato accounts sync (if Blotato wired)

In Settings → Blotato section, click "Sync with Blotato". Then check:

```sql
SELECT blotato_facebook_account_id, blotato_facebook_page_id,
       blotato_instagram_account_id,
       blotato_linkedin_account_id, blotato_linkedin_page_id
FROM settings WHERE user_id = '<USER_ID>';
```

Expected: rows populated with current Blotato accountIds. Cross-check with the Blotato dashboard.

If accountIds change later (owner reconnected), repeat the Sync. Don't try to debug "Account not found" errors before syncing — 90% of the time it's just drift. (Gotcha #15.)

## Test 8 — End-to-end publish (lowest-risk version)

Pick an already-approved post with a ready asset:

```sql
INSERT INTO scheduled_posts (id, user_id, post_id, platform, scheduled_at, timezone, status, created_at, updated_at)
VALUES (gen_random_uuid(), '<USER_ID>', '<POST_ID>', 'linkedin',
  NOW() + INTERVAL '10 sec',
  'Asia/Jerusalem', 'scheduled', NOW(), NOW());
```

Wait 30 seconds. Then:

```sql
SELECT s.status, p.result, p.attempts
FROM scheduled_posts s
JOIN jobs p ON p.payload::jsonb ->> 'scheduledPostId' = s.id
WHERE s.id = '<SCHEDULED_ID>'
ORDER BY p.created_at DESC LIMIT 1;
```

Expected: `s.status='published'`, `blotato_submission_id` populated, `publishing_logs` has a success row with `external_url`.

If failed — read `publishing_logs.message` for the actual error. Most common: account-id drift (gotcha #15) or nested body issue (gotcha #14).

## Test 9 — End-to-end through the UI

Best done by a human:

1. Open `https://your-domain` in a browser
2. Log in
3. Click "Discover topics" → wait ~30s → 4 topics should appear with Hebrew titles + trend scores
4. Click a topic → "Approve" → wait ~2 min → 3 posts appear under "Posts" tab with images/videos
5. Click a post → "Schedule" → opens calendar → drag to a future slot → confirm
6. Wait until the scheduled time → check Publishing tab → should show "published" with external URL

If any of these break, the per-test scripts above will tell you exactly which layer.

## Test 10 — Auto-deploy works

```bash
# Make a trivial change
echo "// trivial" >> src/app/page.tsx
git add -A && git commit -m "trivial: smoke test auto-deploy"
git push origin main
```

Within ~30 seconds Railway should start a new deploy. You'll get a notification in the dashboard. Wait ~3 min for the build to finish. Verify:

```bash
curl -s "https://your-domain/api/health" | jq .uptime
```

`uptime` should be < 60s (new container just started).

If no deploy fires — Railway GitHub App isn't installed correctly. Reinstall from Railway → Settings → GitHub.

---

## Common emergency commands

```bash
# Tail Railway logs in real-time
railway logs --service lara-creator

# Force restart the service
railway redeploy --service lara-creator

# Roll back to previous deployment
# In Railway dashboard → Deployments → click previous → "Rollback to this"

# Check Supabase connection from the worker side
curl -s "https://your-domain/api/health" | jq .worker
```

---

## When everything goes sideways

If the system is unusable and you don't know why:

1. Check `/api/health` — is the worker running?
2. Check Railway logs — is there a recent crash?
3. Check `SELECT count(*) FROM jobs WHERE status='running' AND started_at < NOW() - INTERVAL '5 min'` — orphans not being reclaimed?
4. Check `SELECT count(*) FROM agent_errors WHERE created_at > NOW() - INTERVAL '1 hour'` — pattern of recent failures?
5. Roll back to last known good deploy in Railway dashboard.
6. Triage from there.
