# Phase 1 — Project Scaffold

This phase produces an empty Next.js 16 + TypeScript + Tailwind v3 project with the exact dependency set the rest of the build expects. Do this before touching Supabase or any API.

## 1.1 Create the Next.js project

```bash
npx create-next-app@16 lara-creator \
  --typescript \
  --eslint \
  --tailwind \
  --app \
  --src-dir \
  --import-alias "@/*" \
  --turbopack=false
cd lara-creator
```

Important flags:
- `--src-dir` — the entire codebase lives under `src/` (matches the file map below)
- `--import-alias "@/*"` — Prisma, agents, and components all use `@/lib/...` and `@/components/...`
- Tailwind comes default at v3, which is what we want — **do not upgrade to v4**

## 1.2 Pin Node 22

In `package.json`, add:
```json
"engines": { "node": ">=22.0.0 <23" }
```

Railway uses Node 22 by default, and Prisma 6 + `@anthropic-ai/sdk` 0.68 both work cleanly on 22. Pinning prevents Railway from auto-upgrading to 24 later and breaking the Prisma engine binary copy.

## 1.3 Install the rest of the dependency set

Run this in a single command — every dep below is used somewhere in the codebase, none is decorative:

```bash
npm install \
  @anthropic-ai/sdk@^0.68.0 \
  @prisma/client@^6.16.2 \
  @radix-ui/react-avatar \
  @radix-ui/react-dialog \
  @radix-ui/react-dropdown-menu \
  @radix-ui/react-label \
  @radix-ui/react-popover \
  @radix-ui/react-scroll-area \
  @radix-ui/react-select \
  @radix-ui/react-separator \
  @radix-ui/react-slot \
  @radix-ui/react-switch \
  @radix-ui/react-tabs \
  @radix-ui/react-tooltip \
  class-variance-authority \
  clsx \
  date-fns \
  fast-xml-parser \
  framer-motion \
  lucide-react \
  recharts \
  sonner \
  tailwind-merge \
  tailwindcss-animate \
  zod

npm install -D \
  prisma@^6.16.2 \
  dotenv-cli \
  tsx \
  autoprefixer@^10.4.21 \
  postcss@^8.5.3
```

## 1.4 Configure `package.json` scripts

Replace the `scripts` block:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start",
    "postinstall": "prisma generate",
    "db:generate": "prisma generate",
    "db:push": "dotenv -e .env.local -- prisma db push",
    "db:studio": "dotenv -e .env.local -- prisma studio"
  }
}
```

Critical:
- `"build": "prisma generate && next build"` — Vercel/Railway caches `node_modules` between builds and may skip `postinstall`. Run `prisma generate` explicitly so the build never sees a stale client. **(Gotcha #3 in `references/10-gotchas-and-pitfalls.md`.)**
- `"postinstall": "prisma generate"` — keep this anyway as a belt-and-suspenders measure.
- `dotenv -e .env.local --` prefix for any command that needs the env vars — Prisma CLI doesn't read `.env.local` by default.

## 1.5 Tailwind config

Keep the default `tailwind.config.ts` but ensure RTL works. Add `dir="rtl"` to `src/app/layout.tsx`:

```tsx
<html lang="he" dir="rtl">
```

And use `lang="he"` everywhere. Heebo is the recommended font (loaded via `next/font/google` in `src/app/layout.tsx`). All directional Tailwind classes should use **logical properties** (`border-s` not `border-l`, `pe-4` not `pr-4`, `ms-auto` not `ml-auto`) so they auto-flip in RTL.

## 1.6 Next.js standalone output

Replace `next.config.ts` with the contents of `assets/next.config.ts`. The critical line is:

```ts
output: "standalone",
```

This bundles only the deps needed for production into `.next/standalone`, which the Dockerfile then copies. Without it, the Docker image ships the full `node_modules` (~500MB → ~80MB).

Also configure remote images so Next can render Kie/FAL CDN URLs and Supabase Storage URLs:

```ts
images: {
  remotePatterns: [{ protocol: "https", hostname: "**" }],
},
```

## 1.7 `.gitignore`

Add these lines (in addition to the Next.js defaults):

```
.env*.local
.mcp.json
prisma/dev.db
.vercel
```

`.env.local` holds all secrets. `.mcp.json` holds the Supabase MCP token. `prisma/dev.db` is the old SQLite file you'll never recreate. `.vercel` is added automatically by `vercel link` even if you don't use Vercel — don't fight it.

## 1.8 Directory skeleton

Create these directories now so later phases drop files in cleanly:

```
src/
├── app/
│   ├── (app)/              # Pages behind auth gate
│   ├── api/
│   ├── login/
│   └── globals.css
├── components/
│   ├── layout/
│   ├── ui/
│   ├── shared/
│   ├── overview/
│   ├── topics/
│   ├── posts/
│   ├── publishing/
│   ├── learning/
│   └── settings/
├── lib/
│   ├── ai/
│   ├── agents/
│   │   └── sources/
│   ├── creative/
│   ├── publishing/
│   ├── queue/
│   ├── storage/
│   └── i18n/
└── instrumentation.ts      # gets filled in Phase 9
prisma/
scripts/
```

## 1.9 Verify

```bash
npm run dev
```

You should see Next.js running at http://localhost:3000 with the default starter page. Kill it (Ctrl+C) and move on to Phase 2.

If `npm run dev` doesn't start:
- check Node version is 22 (`node --version`)
- check for stale env vars in your shell that might be shadowing things (Windows specifically — see Gotcha #4 in pitfalls)

---

**Next:** `references/02-supabase-database.md`
