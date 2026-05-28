# Phase 4 — Image + Video Providers (Kie.ai + Fal.ai)

The creative agent renders an image or video for every approved post. Two providers behind a single interface — the owner picks one in Settings; if it has no key, the system falls back to a built-in SVG placeholder so the queue never deadlocks.

## 4.1 Get API keys

### Kie.ai (default for Nano Banana 2)
1. Sign up at https://kie.ai
2. Account → API keys → create
3. `.env.local`:
   ```
   KIE_API_KEY="..."
   ```
4. Top up at least $5 of credit — Nano Banana 2 images cost ~$0.03 each, Seedance 2.0 video ~$0.30 per 5s clip.

### Fal.ai (alternate)
1. Sign up at https://fal.ai
2. Dashboard → Keys → create
3. `.env.local`:
   ```
   FAL_API_KEY="..."
   ```
4. Top up similarly.

Either provider works — Kie.ai is the recommended default because Nano Banana 2 is excellent for Hebrew/marketing content, and Kie's pricing for Seedance 2.0 video is competitive.

## 4.2 The provider interface

Create `src/lib/creative/providers.ts`. The full reference implementation is in the main source (see SKILL.md links), but the contract is:

```ts
export interface CreativeRequest {
  prompt: string;
  seed: string;
  platform: string;       // facebook | instagram | linkedin
  label?: string;
  model?: string;
  media?: "image" | "video";    // default: image
}

export interface AssetResult {
  imageUrl: string;       // a CDN URL — for video this is the .mp4 URL
  provider: string;
  model?: string;
  generationTimeMs: number;
}

export interface CreativeProvider {
  name: string;
  isConfigured(): boolean;
  defaultModel(): string;
  generate(req: CreativeRequest): Promise<AssetResult>;
}
```

Three concrete providers:
- `PlaceholderProvider` — emergency fallback, returns an SVG data URL. Always configured.
- `KieProvider` — Kie.ai (default).
- `FalProvider` — Fal.ai.

`getCreativeProviderWithFallback(name)` returns the picked provider if it's configured, otherwise placeholder + `fellBack: true`. This pattern means a missing key never crashes a creative job — it just produces a placeholder you can regenerate later when the key arrives.

## 4.3 Kie.ai integration — createTask + polling

Kie.ai uses an async pattern. Three calls per generation:

```
POST https://api.kie.ai/api/v1/jobs/createTask
     Headers: Authorization: Bearer <KIE_KEY>
     Body:    { model: "nano-banana-2", input: { prompt, aspect_ratio, ... } }
     Returns: { code: 200, data: { taskId } }

(poll until done)
GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
     Returns: { code, data: { state: "waiting"|"queuing"|"generating"|"success"|"fail", resultJson?: { resultUrls?: [], videoUrl? } } }
```

The `resultJson` field is a JSON-encoded **string** when the model returns success — parse it before reading `resultUrls[0]`.

### Model IDs (verified working as of build time — re-verify before relying)

**Image models** (Kie format: bare model id):

| ID | Notes |
|----|-------|
| `nano-banana-2` (default) | Gemini 3.1 Flash Image. Premium quality, 4K. |
| `gpt-image-2` | OpenAI's photo realism model. Slow but premium. |
| `nano-banana-pro` | Gemini 3 Pro Image. |
| `flux-kontext-pro` / `flux-kontext-max` | FLUX variants. |
| `qwen-image` | Supports Hebrew text in image — useful for posters. |
| `nano-banana` | Older Gemini 2.5 Flash variant. |

**Video models** (Kie format: `vendor/model-id`):

| ID | Notes |
|----|-------|
| `bytedance/seedance-2` (default) | Verified. Takes ~5min — be patient. |
| `kling-3.0/video` | Requires extra fields: `{sound:false, mode:"std", multi_shots:false}` |
| `grok-imagine/text-to-video` | xAI. Only `prompt` field. |
| `bytedance/seedance-2-fast` | Faster, slightly lower quality. |
| `bytedance/seedance-1.5-pro` | Older but reliable fallback. |

**Veo 3.1 is intentionally excluded** — it uses a different endpoint (`POST /api/v1/veo/generate` with flat body, not `createTask`). Adding it requires refactoring `KieProvider`.

### Branching for input shape

Different model families want different fields. Build `input` based on the model:

```ts
private buildInput(model: string, req: CreativeRequest) {
  const media = req.media ?? "image";
  if (media === "video") {
    if (model.startsWith("kling")) {
      return { prompt: req.prompt, sound: false, duration: 5,
               aspect_ratio: aspectRatioFor(req.platform, "video"),
               mode: "std", multi_shots: false };
    }
    if (model.startsWith("grok-imagine")) {
      return { prompt: req.prompt };
    }
    return { prompt: req.prompt,
             aspect_ratio: aspectRatioFor(req.platform, "video"),
             duration: 5 };
  }
  // image:
  const input: any = { prompt: req.prompt, aspect_ratio: aspectRatioFor(req.platform, "image") };
  if (model.includes("nano-banana")) { input.resolution = "1K"; input.output_format = "png"; }
  if (model.includes("gpt-image"))    { input.output_format = "png"; }
  return input;
}
```

### Polling timeouts

- Image: poll every 3s, up to 60 attempts → ~3 minutes.
- Video: poll every 5s, up to 100 attempts → ~8 minutes.

Seedance 2.0 routinely takes 5+ minutes. Don't shortcut this. (Gotcha #5: Vercel will timeout long before — that's why we run on Railway.)

## 4.4 Fal.ai integration — queue + polling

Fal uses a different but structurally similar pattern:

```
POST https://queue.fal.run/<model>
     Headers: Authorization: Key <FAL_KEY>
     Body:    { prompt, aspect_ratio | image_size, num_images, ... }
     Returns: { request_id, status_url, response_url }

GET  <status_url>     → { status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED"|"FAILED" }
GET  <response_url>   → { images: [{url}], video?: {url}, video_url? }
```

### Model IDs

**Image models** — most use `fal-ai/` prefix:

| ID | Param style |
|----|-------------|
| `fal-ai/nano-banana-2` (default) | `aspect_ratio` |
| `openai/gpt-image-2` | `aspect_ratio` |
| `fal-ai/nano-banana-pro` | `aspect_ratio` |
| `fal-ai/flux/schnell` / `flux/dev` | `image_size` (legacy) |
| `fal-ai/flux-pro/v1.1-ultra` | `aspect_ratio` |
| `fal-ai/recraft-v3` | `image_size` |
| `fal-ai/ideogram/v2` | `aspect_ratio` |

**Video models — Critical gotcha:**

ByteDance Seedance models on FAL use **bare vendor path** without the `fal-ai/` prefix. Other model families do use `fal-ai/` (Kling, Veo, Runway).

| ID | Notes |
|----|-------|
| `bytedance/seedance-2.0/text-to-video` (default) | NO `fal-ai/` prefix. Sends `generate_audio: false`. |
| `fal-ai/kling-video/v2.5/pro/text-to-video` | `fal-ai/` prefix. |
| `fal-ai/veo3` | Always generates audio (model ignores `generate_audio`). |
| `fal-ai/runway-gen4/turbo` | Fast. |
| `fal-ai/bytedance/seedance/v1/pro/text-to-video` | Older Seedance — uses `fal-ai/` prefix. |

If you add a Seedance variant and prefix it with `fal-ai/`, Fal accepts the request, reports `COMPLETED`, but the response 404s — wasted hours of debugging. (Gotcha #6.)

### `generate_audio: false` for Seedance

By default Fal Seedance generates loud auto-generated audio in the .mp4. For a social-media UGC system you almost certainly want silent. Send `generate_audio: false` when the model id contains `"seedance"`. Veo3 and Sora ignore the flag and always generate audio — that's accepted (you can mute on the client).

## 4.5 Aspect ratios by platform + media

Build helpers:

```ts
function aspectRatioFor(platform: string, media: "image" | "video" = "image"): string {
  if (media === "video") {
    if (platform === "linkedin") return "16:9";  // landscape for LinkedIn feed
    return "9:16";                                // IG Reels, FB Reels
  }
  if (platform === "instagram") return "1:1";
  return "16:9";                                  // FB feed, LinkedIn feed
}
```

**LinkedIn note:** LinkedIn's spec image is 1.91:1 (1200×627). Kie rejects `1.91:1` with "not within range of allowed options". `16:9` is the closest accepted value; LinkedIn renders it cleanly. (Gotcha #7.)

## 4.6 Mirror to Supabase Storage — the URL stability problem

Both Kie and FAL return CDN URLs that expire in 7-30 days. A post scheduled for 6 weeks from now would publish with a 404 image. **Fix:** download the asset and re-upload to Supabase Storage immediately after generation.

Create `src/lib/storage/mirror.ts`:

```ts
import { env, hasSupabaseServiceRoleKey, supabaseUrl } from "@/lib/env";

const BUCKET = "creative-assets";

export async function mirrorToSupabase(externalUrl: string, assetId: string, userId: string): Promise<string> {
  if (!hasSupabaseServiceRoleKey()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  }
  const fetchRes = await fetch(externalUrl);
  if (!fetchRes.ok) throw new Error(`Failed to download from ${externalUrl}: ${fetchRes.status}`);

  const contentType = fetchRes.headers.get("content-type") ?? "image/png";
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new Error(`Unexpected content-type=${contentType} — CDN may have returned an error page`);
  }

  const ext = contentType.includes("png") ? "png"
    : contentType.includes("jpeg") ? "jpg"
    : contentType.includes("webp") ? "webp"
    : contentType.includes("mp4")  ? "mp4"
    : contentType.includes("webm") ? "webm"
    : contentType.includes("quicktime") ? "mov" : "png";

  const bytes = Buffer.from(await fetchRes.arrayBuffer());
  const path = `${userId}/${assetId}.${ext}`;
  const uploadUrl = `${supabaseUrl()}/storage/v1/object/${BUCKET}/${path}`;

  // CRITICAL: send BOTH apikey and Authorization headers.
  // New sb_secret_* keys are NOT JWT — Storage rejects them on Bearer alone with "Invalid Compact JWS".
  // The apikey header path works for both old JWT keys and new sb_secret_* keys.
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey:         env.supabaseServiceRoleKey,
      Authorization:  `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": contentType,
      "x-upsert":     "true",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(`Storage upload failed (${uploadRes.status}): ${text.slice(0, 240)}`);
  }
  return `${supabaseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
}
```

The **dual-header pattern** (`apikey` + `Authorization: Bearer`) is what fixed the "Invalid Compact JWS" error after Supabase rolled out the new key format. Old keys (JWT) accept either path; new keys (`sb_secret_*`) require `apikey`.

In the creative handler, after `provider.generate()` succeeds:

```ts
const result = await provider.generate(req);
const publicUrl = await mirrorToSupabase(result.imageUrl, asset.id, userId);
await prisma.creativeAsset.update({
  where: { id: asset.id },
  data: { imageUrl: result.imageUrl, publicUrl, status: "ready" },
});
```

The `imageUrl` field keeps the original CDN URL for debugging; `publicUrl` is the stable one published to social media.

## 4.7 Verify

```bash
# scripts/verify-kie.mjs
import "dotenv/config";

const r = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "nano-banana-2", input: { prompt: "a red apple, photo-real", aspect_ratio: "1:1", resolution: "1K", output_format: "png" } }),
});
const j = await r.json();
console.log("createTask:", JSON.stringify(j, null, 2));
```

You should get `{code: 200, data: { taskId: "..." }}`. Wait 30s and poll `/recordInfo?taskId=...` — you should see `state` progress through `waiting → queuing → generating → success`.

---

**Next:** `references/05-blotato-publishing.md`
