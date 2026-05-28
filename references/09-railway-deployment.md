# Phase 9 — Railway Deployment

This is the deploy that *works*. Vercel does not work for this app because of the 60-second function timeout — Seedance 2.0 video generations routinely take 5+ minutes and get SIGTERM'd mid-flight, leaving jobs stuck in `running` forever.

Railway runs the Next.js Node process as a long-lived container. The queue worker runs **inside the same process** with `setTimeout`-based polling. No HTTP hop, no timeout cap.

## 9.1 The Dockerfile

Copy `assets/Dockerfile` to your project root. Three stages:

1. **deps** — install dependencies with `npm ci`. The `prisma` directory is copied before install so the `postinstall` step (`prisma generate`) finds the schema.
2. **build** — copy `node_modules`, run `npm run build` (which is `prisma generate && next build`). Produces `.next/standalone`.
3. **runner** — Alpine, non-root user, copy ONLY the standalone bundle + Prisma engine binaries. Image size ~250-350MB.

**Critical lines:**

```dockerfile
RUN apk add --no-cache libc6-compat openssl
```
on every stage. Alpine doesn't have these by default and Prisma's engine binaries won't load without them. Symptom: `Error: libcrypto.so.1.1: cannot open shared object file`.

```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
```
Next.js standalone bundling **misses** the Prisma engine binaries. You must copy them explicitly. Symptom: `Cannot find module @prisma/engines`.

```dockerfile
ENV HOSTNAME=0.0.0.0
```
Without this, Next.js binds to localhost only and Railway's healthcheck fails.

## 9.2 `next.config.ts` — standalone output

Copy `assets/next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};
```

`output: "standalone"` is required — without it, the Dockerfile's `COPY --from=builder /app/.next/standalone ./` would fail (no standalone dir produced).

## 9.3 The instrumentation hook — `src/instrumentation.ts`

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startWorker } = await import("./lib/queue/worker");
  startWorker();
}
```

Next.js calls `register()` once on server boot. The two guards:
- `NEXT_RUNTIME !== "nodejs"` skips Edge runtime and middleware.
- `NEXT_PHASE === "phase-production-build"` skips during `next build` — otherwise the build process imports route modules and would try to start a worker.

Dynamic import keeps the worker code out of any client bundle.

## 9.4 The in-process worker — `src/lib/queue/worker.ts`

```ts
import { drain } from "./dispatcher";

const POLL_INTERVAL_MS = 15_000;
const TICK_LIMIT = 4;

type WorkerState = {
  started: boolean;
  lastTickAt: number | null;
  timer: NodeJS.Timeout | null;
};

// CRITICAL: state on globalThis with a Symbol key.
// Next.js standalone duplicates modules — instrumentation.ts loads one
// instance, route handlers (like /api/health) load another. Without
// globalThis, the route handler's `started` flag is always false.
const STATE_KEY = Symbol.for("lara-creator.queue.worker.state");
const globalSlot = globalThis as unknown as { [STATE_KEY]?: WorkerState };
const state: WorkerState = (globalSlot[STATE_KEY] ??= {
  started: false, lastTickAt: null, timer: null,
});

export function getWorkerStatus() {
  return { started: state.started, lastTickAt: state.lastTickAt };
}

export function startWorker(): void {
  if (state.started) return;
  state.started = true;
  console.log(`[worker] starting (poll ${POLL_INTERVAL_MS}ms, tickLimit ${TICK_LIMIT})`);

  const tickOnce = async () => {
    try {
      const r = await drain({ tickLimit: TICK_LIMIT });
      state.lastTickAt = Date.now();
      if (r.processed > 0 || r.failed > 0 || r.reclaimed > 0) {
        console.log(`[worker] processed=${r.processed} failed=${r.failed} reclaimed=${r.reclaimed}`);
      }
    } catch (err) {
      state.lastTickAt = Date.now();
      console.error("[worker] drain threw:", err);
    }
  };

  // Self-rescheduling — next setTimeout fires only after this tick fully completes.
  // setInterval would let overlapping ticks fire if drain() runs long.
  const loop = async () => {
    await tickOnce();
    if (state.started) state.timer = setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();

  const stop = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.started = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
```

### Why `setTimeout` not `setInterval`

`setInterval(15s)` would fire a new tick every 15s **regardless** of whether the previous tick is done. A video-generation drain that takes 5 minutes would have 20 overlapping ticks racing for the same jobs. `setTimeout`-rescheduled-after-await means no overlap is possible.

### Why `tickLimit: 4`

The dispatcher's default is 8. We override to 4 because creative.generate can take 60+ seconds at full Kie throughput, and Prisma's default connection pool is ~25 connections. 4 parallel jobs × 1 Prisma connection each + HTTP requests = fits comfortably. Raise if you observe headroom; lower if you see "too many connections" errors.

### Why `globalThis[Symbol.for(...)]`

Next.js standalone with App Router loads modules in **two contexts**: the instrumentation hook context (called once at boot) and the route handler context (called per request). Each context gets its own JS module instance. Without `globalThis`, `started=true` in one context and `started=false` in the other.

`Symbol.for(key)` is the cross-realm symbol registry — returns the same Symbol object across all module instances. So both contexts read the same state object. (Gotcha #10.)

## 9.5 The healthcheck — `src/app/api/health/route.ts`

```ts
import { NextResponse } from "next/server";
import { getWorkerStatus } from "@/lib/queue/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_TICK_THRESHOLD_MS = 10 * 60 * 1000;   // 10 min

export function GET() {
  const status = getWorkerStatus();
  const now = Date.now();
  const tickAge = status.lastTickAt ? now - status.lastTickAt : null;
  const isStale = status.started && tickAge !== null && tickAge > STALE_TICK_THRESHOLD_MS;

  return NextResponse.json({
    ok: status.started && !isStale,
    worker: {
      started: status.started,
      lastTickAt: status.lastTickAt ? new Date(status.lastTickAt).toISOString() : null,
      tickAgeMs: tickAge,
      stale: isStale,
    },
    uptime: process.uptime(),
  }, { status: status.started && !isStale ? 200 : 503 });
}
```

Why 10 minutes for staleness: drain() during a video can block tick logging for 5+ minutes, so 10min gives plenty of slack. A truly stuck worker still gets caught.

## 9.6 Set up Railway

1. Sign up at https://railway.app (GitHub login is easiest)
2. **Install the Railway GitHub App** on your repo (Railway dashboard → Settings → GitHub → Install)
3. **New Project → Deploy from GitHub repo** → select your `lara-creator` repo
4. Railway autodetects the Dockerfile and starts building
5. Wait ~5 minutes for first build (subsequent builds ~2 min thanks to Docker layer cache)

## 9.7 Set env vars in Railway

In your service → **Variables** → paste these. **Don't forget**:

```
DATABASE_URL=postgresql://postgres.<REF>:<PASS>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=20
DIRECT_URL=postgresql://postgres.<REF>:<PASS>@aws-0-<REGION>.pooler.supabase.com:5432/postgres
ANTHROPIC_API_KEY=sk-ant-...
KIE_API_KEY=...
FAL_API_KEY=...
BLOTATO_API_KEY=...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
OWNER_EMAIL=you@example.com
NEXT_PUBLIC_APP_URL=https://your-railway-url.up.railway.app
NODE_ENV=production
```

The `&connection_limit=20` on DATABASE_URL is non-negotiable — without it, the worker hits "too many connections" under modest load.

## 9.8 Configure the healthcheck

In your service → **Settings → Networking**:
- **Healthcheck Path:** `/api/health`
- **Healthcheck Timeout:** 30 seconds
- **Startup Timeout:** 300 seconds (first boot can be slow as Prisma initializes)

Railway will ping `/api/health` during startup and won't route traffic until it returns 200.

## 9.9 First deploy

Push to `main`. Railway auto-deploys. Watch the **Deployments** tab:

```
✅ Build succeeded (Docker)
✅ Deploy in progress
✅ Healthcheck passing (/api/health → 200)
🌍 Live at https://lara-creator-production.up.railway.app
```

Visit the URL. You should see the login page. Choose a password (SetupForm). You should be on the dashboard.

## 9.10 Custom domain (optional)

In **Settings → Networking → Custom Domains**:
- Click **+ Custom Domain**
- Enter `yoursite.example.com`
- Railway shows a CNAME target like `d5xwdm5w.up.railway.app`

In Namecheap (or your DNS provider):
- Type: **CNAME**
- Host: `yoursite` (or `@` for root — note that some DNS providers don't support CNAME on root; use ALIAS or A-record if available)
- Value: `d5xwdm5w.up.railway.app`
- TTL: 30 minutes

Wait ~5-30 min for DNS propagation. Railway auto-issues a Let's Encrypt cert within ~90 seconds of the cutover. Verify with `curl -I https://yoursite.example.com` — should return 200.

After verifying, update `NEXT_PUBLIC_APP_URL` in Railway to the custom domain.

## 9.11 Verify the live system

```bash
curl https://your-domain/api/health
```

Should return:

```json
{
  "ok": true,
  "worker": {
    "started": true,
    "lastTickAt": "2026-05-28T12:34:56.789Z",
    "tickAgeMs": 8421,
    "stale": false
  },
  "uptime": 142.3
}
```

If `started: false` — instrumentation didn't fire. Check Railway logs for the line `[worker] starting (poll 15000ms, tickLimit 4)`.

If `stale: true` — worker tick loop crashed. Check logs for the most recent `[worker] drain threw:` line.

If 404 — the healthcheck route didn't deploy. Check `src/app/api/health/route.ts` exists and that the build succeeded.

## 9.12 Watch out for

- **DON'T set up pg_cron** to call `/api/cron/tick`. The Vercel design needed cron because Vercel can't run a long-lived worker. On Railway the in-process worker IS the engine; an external cron would race with it.
- **Auto-deploy works on Railway** (unlike Vercel — where the GitHub integration silently fails for many private repos). Just `git push origin main`. You'll see a deploy start within ~10 seconds.
- **Redeploys SIGTERM the current container.** The worker's `process.on("SIGTERM")` handler exits cleanly, but if a job was 90% through Seedance generation it gets killed. Orphan recovery (Phase 6) reclaims it next time.
- **Don't `vercel deploy`** out of habit. If you're rolling back to Vercel as emergency insurance, the in-process worker won't run there and pg_cron has to come back. Better to fix forward on Railway.

---

**Next:** `references/10-gotchas-and-pitfalls.md` (the must-read list)
