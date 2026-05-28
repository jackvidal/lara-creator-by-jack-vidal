# Phase 7 — Source Adapters

The research agent pulls trends from 5 real sources in parallel: Hacker News, Reddit, Product Hunt, YouTube, RSS. Each implements the same `SourceAdapter` interface; the aggregator runs all 5 with `Promise.allSettled` so a single broken source doesn't kill the whole run.

If you want to retarget the system to a different niche (gaming, fashion, fintech), this is the only phase you need to modify. The agents themselves are niche-agnostic.

## 7.1 The interface — `src/lib/agents/sources/types.ts`

```ts
export interface RawTrend {
  title:      string;
  summary:    string;
  sourceName: string;
  sourceUrl:  string;
  tags:       string[];
}

export interface SourceAdapter {
  name: string;
  fetchRawTrends(): Promise<RawTrend[]>;
}
```

Aggregator — `src/lib/agents/sources/index.ts`:

```ts
import { MOCK_TRENDS, isBlockedTitle } from "../mock-sources";
import { hackerNewsAdapter }  from "./hackernews";
import { redditAdapter }      from "./reddit";
import { productHuntAdapter } from "./producthunt";
import { youtubeAdapter }     from "./youtube";
import { rssAdapter }         from "./rss";

const ADAPTERS = [hackerNewsAdapter, redditAdapter, productHuntAdapter, youtubeAdapter, rssAdapter];

export async function fetchAllSources(): Promise<RawTrend[]> {
  const results = await Promise.allSettled(
    ADAPTERS.map(async (a) => {
      const start = Date.now();
      try {
        const trends = await a.fetchRawTrends();
        console.log(`[sources] ${a.name}: ${trends.length} in ${Date.now() - start}ms`);
        return trends;
      } catch (err) {
        console.error(`[sources] ${a.name} threw:`, err);
        return [];
      }
    }),
  );

  const all: RawTrend[] = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);

  const seen = new Set<string>();
  const deduped: RawTrend[] = [];
  for (const t of all) {
    if (!t.sourceUrl || seen.has(t.sourceUrl)) continue;
    if (isBlockedTitle(t.title)) continue;
    seen.add(t.sourceUrl);
    deduped.push(t);
  }

  // Fallback to mock if every source failed
  if (deduped.length === 0) {
    console.warn("[sources] all adapters returned 0 — falling back to MOCK_TRENDS");
    return MOCK_TRENDS.filter((t) => !isBlockedTitle(t.title));
  }
  return deduped;
}
```

## 7.2 fetch-utils — shared timeout + UA + safe-* helpers

`src/lib/agents/sources/fetch-utils.ts`:

```ts
const TIMEOUT_MS = 8000;
const UA = "LaraCreator/1.0 (+https://your-domain.example.com)";

export async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(id);
  }
}

export async function safeFetchJSON<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetchWithTimeout(url, init);
    if (!r.ok) { console.warn(`[fetch] ${url} → ${r.status}`); return null; }
    return await r.json() as T;
  } catch (err) {
    console.warn(`[fetch] ${url} threw:`, err);
    return null;
  }
}

export async function safeFetchText(url: string, init?: RequestInit): Promise<string | null> {
  try {
    const r = await fetchWithTimeout(url, init);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}
```

**Set the User-Agent** with a contact URL. Some sources (Reddit, Hacker News) rate-limit or ban anonymous default node-fetch user agents.

## 7.3 The blocklist + mock fallback — `src/lib/agents/mock-sources.ts`

```ts
const BLOCKED_TITLE_KEYWORDS: string[] = [
  // Add substrings here when the owner says "stop suggesting X".
  // Case-insensitive substring match. Filters BEFORE Haiku scoring,
  // so it also covers RSS/YouTube/Reddit sources.
  "sora 2",
];

export function isBlockedTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return BLOCKED_TITLE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

// MOCK fallback — only used when every adapter returns 0 (offline/rate-limited).
// Keep titles in Hebrew so the dashboard isn't ugly when offline.
export const MOCK_TRENDS: RawTrend[] = [
  // ... 5-10 evergreen entries
];
```

When the owner asks to stop suggesting a specific tool, **add a substring here** — don't invent a new blocklist mechanism. The filter runs before Haiku scoring, so it saves the cost of scoring known-bad topics and works across all 5 sources. (Gotcha #11.)

## 7.4 Hacker News adapter — `src/lib/agents/sources/hackernews.ts`

```ts
import { safeFetchJSON } from "./fetch-utils";

const CREATIVE_KEYWORDS = [
  "midjourney","stable diffusion","sd","sora","veo","runway","kling",
  "comfyui","flux","nano banana","imagen","firefly","ideogram",
  "suno","udio","music ai","video gen","image gen","ai video","ai music",
  "ai art","ai design","ai illustration","ai animation",
];

async function fetchHN(): Promise<RawTrend[]> {
  // 1. Top stories
  const ids = await safeFetchJSON<number[]>("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!ids) return [];

  const top200 = ids.slice(0, 200);
  // 2. Fetch each story (parallelized in batches)
  const out: RawTrend[] = [];
  for (let i = 0; i < top200.length; i += 20) {
    const batch = await Promise.all(top200.slice(i, i + 20).map(id =>
      safeFetchJSON<{ title?: string; url?: string; text?: string }>(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`
      )
    ));
    for (const s of batch) {
      if (!s?.title) continue;
      if (!s.url && !s.text) continue;
      const lower = (s.title + " " + (s.text ?? "")).toLowerCase();
      if (!CREATIVE_KEYWORDS.some(kw => lower.includes(kw))) continue;
      out.push({
        title:      s.title,
        summary:    (s.text ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
        sourceName: "Hacker News",
        sourceUrl:  s.url ?? `https://news.ycombinator.com/item?id=${id}`,
        tags:       ["hn"],
      });
    }
  }
  return out;
}

export const hackerNewsAdapter: SourceAdapter = { name: "hackernews", fetchRawTrends: fetchHN };
```

## 7.5 Reddit adapter

```ts
const SUBREDDITS = [
  "StableDiffusion","midjourney","aivideo","runwayml","comfyui","aiArt","SunoAI",
  // For other niches, swap these.
];

async function fetchReddit(): Promise<RawTrend[]> {
  const out: RawTrend[] = [];
  for (const sub of SUBREDDITS) {
    const json = await safeFetchJSON<{ data?: { children?: any[] } }>(
      `https://www.reddit.com/r/${sub}/hot.json?limit=20`
    );
    if (!json?.data?.children) continue;
    for (const c of json.data.children) {
      const d = c.data;
      if (d.stickied) continue;
      out.push({
        title:      d.title,
        summary:    stripMarkup((d.selftext ?? "").slice(0, 600)),
        sourceName: `r/${sub}`,
        sourceUrl:  `https://reddit.com${d.permalink}`,
        tags:       ["reddit", sub],
      });
    }
  }
  return out;
}
```

`stripMarkup` (in `rss-parse.ts`) removes HTML tags, markdown links, bold, headings, code fences — otherwise Reddit's selftext bleeds raw markdown into Claude's prompt.

## 7.6 Product Hunt adapter

PH has no public API for general feeds. The hack: parse their RSS:

```ts
async function fetchPH(): Promise<RawTrend[]> {
  const xml = await safeFetchText("https://www.producthunt.com/feed");
  if (!xml) return [];
  const items = parseRssItems(xml);  // helper from rss-parse.ts
  const out: RawTrend[] = [];
  for (const item of items) {
    const lower = (item.title + " " + item.description).toLowerCase();
    if (!CREATIVE_KEYWORDS.some(kw => lower.includes(kw))) continue;
    out.push({
      title:      item.title,
      summary:    stripMarkup(item.description).slice(0, 400),
      sourceName: "Product Hunt",
      sourceUrl:  item.link,
      tags:       ["producthunt"],
    });
  }
  return out;
}
```

**Endpoint gotchas:** the topic-specific PH feeds (`/topics/.../feed`) return 403/404. Only the general `/feed` works publicly. Filter by keywords client-side.

## 7.7 YouTube adapter — channel ID method

YouTube provides RSS for any channel at `https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>`. You need the channel ID (starts with `UC`, 24 chars):

```ts
const CHANNELS = [
  { id: "UCSHZKyawb77ixDdsGog4iWA", name: "Lex Fridman" },     // verified
  // To add a channel:
  // 1. Open youtube.com/@<handle>
  // 2. View source
  // 3. Grep for `"channelId":"UC...`
  // 4. Paste here
];

async function fetchYT(): Promise<RawTrend[]> {
  const out: RawTrend[] = [];
  for (const c of CHANNELS) {
    const xml = await safeFetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`);
    if (!xml) continue;
    const items = parseAtomItems(xml);  // helper
    for (const item of items.slice(0, 5)) {
      out.push({
        title:      item.title,
        summary:    item.description.slice(0, 400),
        sourceName: c.name,
        sourceUrl:  item.link,
        tags:       ["youtube", c.id],
      });
    }
  }
  return out;
}
```

**Channel-ID gotcha:** the obvious-looking `youtube.com/@handle` doesn't give you the channel ID directly. Use the View Source method. Lots of guides online suggest the wrong format. (Gotcha #24 in source.)

## 7.8 RSS adapter — general-purpose

Curate 5-10 feeds for your niche:

```ts
const FEEDS = [
  { url: "https://aituts.com/feed/",          name: "AI Tuts" },
  { url: "https://blog.fal.ai/rss",            name: "FAL Blog" },
  { url: "https://www.creativebloq.com/feed",  name: "Creative Bloq" },
  // Add more for your niche
];

async function fetchRSS(): Promise<RawTrend[]> {
  const out: RawTrend[] = [];
  for (const f of FEEDS) {
    const xml = await safeFetchText(f.url);
    if (!xml) continue;
    const items = parseRssOrAtomItems(xml);
    for (const item of items.slice(0, 5)) {
      out.push({
        title:      item.title,
        summary:    stripMarkup(item.description).slice(0, 400),
        sourceName: f.name,
        sourceUrl:  item.link,
        tags:       ["rss"],
      });
    }
  }
  return out;
}
```

## 7.9 RSS parser — `src/lib/agents/sources/rss-parse.ts`

Use `fast-xml-parser` (already installed Phase 1). Handle both RSS 2.0 and Atom:

```ts
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface RssItem { title: string; link: string; description: string; }

export function parseRssOrAtomItems(xml: string): RssItem[] {
  const obj = parser.parse(xml);
  // RSS 2.0
  if (obj.rss?.channel?.item) {
    const items = Array.isArray(obj.rss.channel.item) ? obj.rss.channel.item : [obj.rss.channel.item];
    return items.map((i: any) => ({
      title:       String(i.title ?? "").trim(),
      link:        String(i.link ?? i.guid ?? "").trim(),
      description: String(i.description ?? i.summary ?? "").trim(),
    }));
  }
  // Atom
  if (obj.feed?.entry) {
    const entries = Array.isArray(obj.feed.entry) ? obj.feed.entry : [obj.feed.entry];
    return entries.map((e: any) => ({
      title:       String(e.title ?? "").trim(),
      link:        e.link?.["@_href"] ?? e.link ?? "",
      description: String(e.summary ?? e.content ?? "").trim(),
    }));
  }
  return [];
}

export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")                    // HTML tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // markdown links
    .replace(/\*\*([^*]+)\*\*/g, "$1")          // **bold**
    .replace(/_([^_]+)_/g, "$1")                // _italic_
    .replace(/^#{1,6}\s+/gm, "")                // headings
    .replace(/```[\s\S]*?```/g, "")             // code fences
    .replace(/\s+/g, " ")
    .trim();
}
```

## 7.10 Diagnostic script

Create `scripts/probe-sources.mjs`:

```js
import "dotenv/config";
import { fetchAllSources } from "../src/lib/agents/sources/index.ts";

const trends = await fetchAllSources();
console.log(`Total: ${trends.length} trends`);
const bySource = new Map();
for (const t of trends) {
  bySource.set(t.sourceName, (bySource.get(t.sourceName) ?? 0) + 1);
}
for (const [name, count] of bySource) console.log(`  ${name}: ${count}`);
```

Run with: `npx tsx scripts/probe-sources.mjs`

Healthy output: ~20-80 trends total with mix from at least 3 sources. If you see 0 trends from a source, that source is broken (URL changed, blocked, rate-limited). Fix it or comment it out.

## 7.11 Retargeting to a different niche

To repoint the system at, say, AI gaming instead of AI creative:

1. Rewrite `CREATIVE_KEYWORDS` in hackernews + producthunt adapters → `GAMING_KEYWORDS`
2. Swap subreddits in reddit adapter → `r/IndieGaming`, `r/Unity3D`, etc.
3. Swap YouTube channels
4. Swap RSS feeds → game dev blogs
5. Rewrite the research agent's SYSTEM prompt (relevance scale) to describe gaming-related criteria
6. Update `DEFAULT_INTERESTS` and `DEFAULT_KEYWORDS` in `src/lib/constants.ts`

Don't change the queue, dispatcher, providers, or auth — those are niche-agnostic.

---

**Next:** `references/08-single-owner-auth.md`
