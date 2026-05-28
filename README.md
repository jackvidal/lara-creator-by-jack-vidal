# lara-creator-by-jack-vidal

A Claude Code skill that builds **Lara Creator** — a production-grade Hebrew RTL multi-agent SaaS for AI-driven content automation — end to end.

The skill walks you through cloning the full system: scaffold → Supabase + Prisma → Anthropic Claude → Kie.ai / Fal.ai image+video → Blotato publishing (optional) → 7-agent queue + dispatcher → 5 source adapters → single-owner auth → Railway deployment with an in-process worker. Following the steps in order avoids the 27+ real bugs documented during the original build.

## What this builds

A live, production-ready system where:

1. **One owner** logs in (single-owner auth, scrypt + HMAC cookie session)
2. The **research agent** sweeps Hacker News, Reddit, Product Hunt, YouTube, and curated RSS feeds in parallel, scores topics with Claude Haiku 4.5, and translates English titles to natural Hebrew — all in one tool_use call
3. The owner approves a topic — the **content agent** writes 3 platform-tailored posts (Facebook + Instagram + LinkedIn) with Claude Opus 4.7
4. The **creative agent** generates an image or video per post via Kie.ai (Nano Banana 2 default) or Fal.ai, mirrors the asset to Supabase Storage for URL stability
5. The **review agent** scores each post 0-100 with concrete improvement suggestions; the owner can one-click "Apply suggestions & rewrite"
6. The owner schedules posts via drag-and-drop calendar; the **publishing agent** dispatches to **Blotato** which handles Facebook Page / Instagram Business / LinkedIn personal-or-Company-Page
7. The **learning agent** distills owner feedback into a style profile that feeds back into future content generation
8. Everything runs on **Railway** with an in-process queue worker (no Vercel — its 60-second function cap kills Seedance video generations)

## Install

### Claude Code

```
# clone into your skills directory
cd ~/.claude/skills
git clone https://github.com/jackvidal/lara-creator-by-jack-vidal.git
```

Then in any Claude Code session, ask "build the Lara Creator system" / "clone Lara Creator" / "מערכת לארה" and the skill activates.

### Plugin / package install

If you have the `present_files` tool or skill installer:
```
python -m scripts.package_skill .
```
This produces a `.skill` file you can drop into Claude Code or Claude.ai.

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router) + TypeScript + Turbopack |
| Styling | Tailwind v3 + shadcn/ui primitives + framer-motion |
| Database | Supabase Postgres (RLS on, Prisma bypasses as superuser) |
| ORM | Prisma 6 (postgresql, directUrl for migrations) |
| AI content | Anthropic Claude — Opus 4.7 for content/review/learning, Haiku 4.5 for research scoring + Hebrew translation |
| AI images | Kie.ai (default) or Fal.ai — provider abstraction, Nano Banana 2 first |
| AI video | Kie Seedance 2.0 (default) or FAL Seedance 2.0 — same abstraction, polling timeouts tuned for ~5-8min generations |
| Queue | Postgres-backed `jobs` table + in-process worker + dispatcher with orphan recovery |
| Auth | Single-owner: scrypt password hash + HMAC cookie session bound to `OWNER_EMAIL` |
| Publishing | Blotato (FB Page + IG Business + LinkedIn personal-or-Company-Page) |
| Deploy | Railway (long-lived Node, no function timeout) — Dockerfile multi-stage Alpine + Prisma engine copy |

## What's in the skill

```
SKILL.md                                  # high-level flow + when to trigger
references/
├── 01-project-setup.md                  # Next.js scaffold + exact deps
├── 02-supabase-database.md              # 16-table schema, RLS, MCP setup
├── 03-anthropic-claude.md               # client + generateStructured + tool_use
├── 04-image-providers-kie-fal.md        # Kie + FAL providers + Storage mirror
├── 05-blotato-publishing.md             # nested body + accountId drift handling
├── 06-multi-agent-system.md             # 7 agents + queue + orphan recovery
├── 07-source-adapters.md                # HN/Reddit/PH/YouTube/RSS + retargeting
├── 08-single-owner-auth.md              # scrypt + HMAC cookie + first-login setup
├── 09-railway-deployment.md             # Dockerfile + instrumentation + healthcheck + DNS
├── 10-gotchas-and-pitfalls.md           # 27+ real bugs with severity, symptom, fix
└── 11-smoke-tests-and-verification.md   # 10 tests to verify the live system
assets/
├── env.example                          # exact env var template
├── prisma-schema.prisma                 # the full 16-model schema
├── Dockerfile                           # multi-stage Alpine, copy Prisma engines
└── next.config.ts                       # standalone output for Docker
```

## Triggering

The skill description is tuned to fire when you ask for Lara Creator specifically OR for a similar Hebrew RTL multi-agent system. Trigger phrases include:

- "Build Lara Creator" / "clone Lara Creator"
- "Build Meirav's system" / "מערכת לארה" / "מערכת לארה קריאייטור"
- "Hebrew RTL multi-agent content SaaS"
- "Multi-agent content automation with Claude + Kie.ai / Fal.ai"
- "Next.js 16 + Supabase + Anthropic + Railway in-process worker"
- "Hebrew translation pipeline with Claude Haiku tool_use"
- "Single-owner SaaS with scrypt password + HMAC cookie session"
- "Blotato FB+IG+LinkedIn publishing integration"

If you want a **different** Hebrew SaaS (CRM, booking, generic dashboard) — use **`hebrew-saas-starter-by-jack-vidal`** instead. That's the general-purpose starter.

## License

MIT. Use freely. Attribution appreciated but not required.

## Credits

Built by Jack Vidal during the actual Lara Creator deployment for Meirav Shavit (`meiravshavit.bp@gmail.com` — the original owner). The 27+ gotchas in `references/10-gotchas-and-pitfalls.md` are real bugs hit during that build — they're the highest-value content in this skill. Reading them once before you start saves days of debugging.
