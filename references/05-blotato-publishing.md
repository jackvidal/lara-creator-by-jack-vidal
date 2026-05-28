# Phase 5 — Blotato Publishing (Optional)

Blotato is a third-party service that handles OAuth + posting to FB, IG, LinkedIn, X, Threads, etc. Lara Creator uses it for **Facebook (Page) + Instagram (Business) + LinkedIn (personal or Company Page)** only. The other platforms are out of scope.

If you skip this phase, the system still works — schedules just stay in "scheduled" status and don't fan out anywhere. The owner can add Blotato later by setting `BLOTATO_API_KEY` and reconnecting accounts in Settings.

## 5.1 Sign up for Blotato

1. Go to https://blotato.com — sign up
2. Connect your FB Page, IG Business, LinkedIn from Blotato's dashboard (their UI handles all the OAuth)
3. Account → API → create API key
4. `.env.local`:
   ```
   BLOTATO_API_KEY="..."
   ```

Pricing: Blotato's pricing varies by plan — typically ~$15-25/month for the tier that includes API access. Check current prices on their site.

## 5.2 The Blotato REST client

Create `src/lib/publishing/blotato.ts`. Only this file knows the Blotato API — if they change endpoints or schema, fix one file:

```ts
import { env, hasBlotatoKey } from "@/lib/env";

const BASE_URL = "https://backend.blotato.com/v2";

function headers() {
  if (!hasBlotatoKey()) throw new Error("BLOTATO_API_KEY missing");
  return {
    Authorization: `Bearer ${env.blotatoApiKey}`,
    "Content-Type": "application/json",
  };
}
```

## 5.3 List accounts

```ts
export async function listAccounts(): Promise<BlotatoAccount[]> {
  const res = await fetch(`${BASE_URL}/users/me/accounts`, { headers: headers() });
  if (!res.ok) throw new Error(`listAccounts ${res.status}`);
  const data = await res.json() as any;
  return Array.isArray(data) ? data : (data.items ?? data.accounts ?? []);
}
```

**Endpoint gotcha:** the natural-sounding `GET /accounts` returns 401. The real path is `GET /users/me/accounts`. (Gotcha #12.)

Each `BlotatoAccount` has `id`, `platform`, `displayName`, `username`, and `subaccounts` (FB Pages + LinkedIn Company Pages). Display these in your Settings UI so the owner can pick which page/account to post to per platform.

## 5.4 Create post — the nested body shape

**This is the most common Blotato bug.** A flat body returns 400 `body. must have required property 'post'`. The correct shape:

```ts
{
  post: {
    accountId:  "<from listAccounts>",
    content: {
      text:      "<post text>",
      mediaUrls: ["<stable public URL — use publicUrl from Supabase Storage>"],
      platform:  "facebook" | "instagram" | "linkedin",
    },
    target: {
      targetType: "facebook" | "instagram" | "linkedin",
      pageId?:    "<FB Page ID>" | "<LinkedIn Company Page ID>",
      mediaType?: "reel" | "story",
      // ...platform-specific extras
    },
  },
  scheduledTime?: "<ISO 8601>",            // top-level, not inside post
}
```

**Per-platform rules:**

- **Facebook:** `target.pageId` is **required** (it's the FB Page ID from `subaccounts`). Optionally include `mediaType: "reel"` for vertical video or `"story"` for 24h Stories.
- **Instagram:** **no `pageId`**. Optionally `mediaType: "reel" | "story"`.
- **LinkedIn:** `target.pageId` **optional**. If present, post comes from a Company Page; if absent, from the personal profile.

Implementation:

```ts
export async function createPost(input: CreatePostInput): Promise<CreatePostResult> {
  const target: Record<string, unknown> = { targetType: input.platform };
  if (input.platform === "facebook") {
    if (!input.pageId) throw new Error("Facebook requires pageId");
    target.pageId = input.pageId;
    if (input.mediaType) target.mediaType = input.mediaType;
  } else if (input.platform === "instagram") {
    if (input.mediaType) target.mediaType = input.mediaType;
  } else if (input.platform === "linkedin") {
    if (input.pageId) target.pageId = input.pageId;
  }

  const body: any = {
    post: {
      accountId: input.accountId,
      content: { text: input.text, mediaUrls: input.mediaUrls, platform: input.platform },
      target,
    },
  };
  if (input.scheduledTime) body.scheduledTime = input.scheduledTime;

  const res = await fetch(`${BASE_URL}/posts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Blotato createPost ${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json();
}
```

If you ever see the 400 "must have required property 'post'" error again, the body went out flat instead of nested. Check the JSON.stringify call. (Gotcha #14.)

## 5.5 Get post status

```ts
export async function getPostStatus(postSubmissionId: string): Promise<PostStatusResult> {
  const res = await fetch(`${BASE_URL}/posts/${encodeURIComponent(postSubmissionId)}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`getPostStatus ${res.status}`);
  return await res.json();
}
```

**Endpoint gotcha:** `GET /posts/{id}/status` returns 404. The real path is `GET /posts/{id}`. (Gotcha #12.)

## 5.6 Status mapping — handle undocumented values

`CreatePostResult.status` is typed as `"published" | "scheduled" | "in-progress" | "failed"`. Empirically Blotato sometimes returns other strings ("success", "completed", etc.). Handle them gracefully — don't throw on unknown status, log a warning and treat as "in-progress", then poll `getPostStatus` after 3-5 seconds. (Gotcha #16.)

## 5.7 Account-ID drift — sync on every reconnect

**This is the most common runtime bug after deployment.** When the owner disconnects and reconnects a platform in Blotato's dashboard (e.g. revoke FB permissions and re-authorize), Blotato assigns a **new accountId**. Your DB still has the old one — every publish fails with `500 "Account 22670 not found"`. (Gotcha #15.)

**Solution:** in your Settings UI, include a **"Sync with Blotato"** button that calls `listAccounts()` and updates the 5 ID fields in the `Settings` table:

```ts
// blotato_facebook_account_id, blotato_facebook_page_id,
// blotato_instagram_account_id,
// blotato_linkedin_account_id, blotato_linkedin_page_id
```

Tell the owner: **"Click Sync whenever you reconnect a platform in Blotato."** Or, more aggressively, sync automatically on every page load of `/settings`.

If a publish fails with `Account NNNNN not found`, the first debug step is always: run `listAccounts()` and compare with the `settings` row.

## 5.8 Scheduled vs immediate

If `scheduledTime` is **more than ~60 seconds in the future**, Blotato schedules the post and dispatches at the right time on its own infrastructure. This is the killer feature — even if your Railway container reboots at 3am, the post still goes out. If `scheduledTime` is closer or omitted, Blotato publishes immediately and polls return progress.

## 5.9 Publishing handler integration

In `src/lib/agents/publishing.ts`, the handler:

1. Loads the `ScheduledPost` row
2. Loads the post, its latest CreativeAsset (use `publicUrl`, the mirrored Supabase URL)
3. Picks accountId+pageId from `Settings` based on platform
4. Calls `createPost`
5. On 200 — writes `blotatoSubmissionId` back to the ScheduledPost, sets status, writes a PublishingLog success row
6. On error — writes a PublishingLog failure row with the message

**Idempotency:** before posting, check if `scheduled_posts.blotatoSubmissionId IS NOT NULL`. If so, skip — the post was already submitted. Combined with `@@unique([postId, platform])` on `scheduled_posts`, this prevents the worst-case double-publish.

## 5.10 Verify

```bash
# scripts/verify-blotato.mjs
import "dotenv/config";
const r = await fetch("https://backend.blotato.com/v2/users/me/accounts", {
  headers: { Authorization: `Bearer ${process.env.BLOTATO_API_KEY}` },
});
console.log(r.status, await r.text());
```

Should return 200 with a JSON list of accounts. If 401, the API key is wrong. If 404, Blotato may have moved the endpoint — check their current docs at https://help.blotato.com/api/openapi-reference/publishing.md.

---

**Next:** `references/06-multi-agent-system.md`
