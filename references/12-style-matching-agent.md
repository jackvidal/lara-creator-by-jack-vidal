# Phase 12 — Style-Matching Agent (Optional)

This phase adds a feature owners reliably ask for once they've used the system for a week: **"the videos look generic — make them in MY style."**

The pipeline:
1. Owner uploads image or video reference samples via a new `/style-references` page
2. A `style.analyze` agent (Claude Opus with vision) extracts a structured style profile per reference — palette, lighting, framing, composition, mood, motion
3. Every `creative.generate` job loads the active references, prepends a distilled style fragment to the image-prompt, and passes the frame URLs as `reference_image_urls` to Nano Banana (image) / Seedance (video)
4. For video: **image-first → animate flow**. Generate a keyframe in the owner's style with Nano Banana 2, mirror to Storage, then call Seedance image-to-video using the keyframe as `first_frame_url`. Same model id on Kie (`bytedance/seedance-2` handles both modes natively); on FAL the provider auto-swaps `text-to-video` → `image-to-video` when a first-frame URL is present.

Skip this phase if the owner is happy with generic visuals. Add it when they aren't.

## 12.1 New table — `StyleReference`

In `prisma/schema.prisma`:

```prisma
model StyleReference {
  id              String   @id @default(uuid())
  userId          String   @map("user_id")
  type            String                                    // 'image' | 'video'
  publicUrl       String   @map("public_url")               // stable Supabase Storage URL
  framePublicUrl  String   @map("frame_public_url")         // for image: same as publicUrl. for video: extracted first-frame PNG
  label           String?
  visionAnalysis  String   @default("{}") @map("vision_analysis")     // JSON: palette, lighting, framing, mood, motion, ...
  analysisStatus  String   @default("pending") @map("analysis_status") // 'pending' | 'analyzing' | 'ready' | 'failed'
  active          Boolean  @default(true)
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@index([userId, active])
  @@index([userId, createdAt])
  @@map("style_references")
}
```

Apply via Supabase MCP `apply_migration` then `ALTER TABLE style_references ENABLE ROW LEVEL SECURITY` (no policies — Prisma bypasses).

## 12.2 New Storage bucket — `style-references`

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'style-references',
  'style-references',
  true,
  104857600,                                      -- 100MB
  ARRAY['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime']
)
ON CONFLICT (id) DO NOTHING;
```

Same shape as `creative-assets` (Phase 2 §2.7). Public read because the URLs need to be embeddable in Nano Banana / Seedance API calls.

## 12.3 Client-side first-frame extraction (no ffmpeg)

Naïve approach: extract video first frame on the server with `ffmpeg-static`. **Don't.** It adds an Alpine-binary dep, fights non-root user permissions, and breaks Docker layer caching.

**Better approach:** the browser already has the codec. In the upload component, when the user picks a video:

```ts
function extractFirstFrame(videoFile: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    const objectUrl = URL.createObjectURL(videoFile);
    video.src = objectUrl;

    const timeout = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Frame extraction timeout"));
    }, 10_000);

    video.onloadeddata = () => {
      // Seek to ~0.1s to avoid black-frame artifacts in some codecs.
      try {
        video.currentTime = Math.min(0.1, video.duration / 2);
      } catch {
        drawAndResolve();
      }
    };
    video.onseeked = () => drawAndResolve();
    video.onerror = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Video failed to load"));
    };

    function drawAndResolve() {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 720;
      canvas.height = video.videoHeight || 1280;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No canvas 2D"));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        clearTimeout(timeout);
        URL.revokeObjectURL(objectUrl);
        blob ? resolve(blob) : reject(new Error("toBlob null"));
      }, "image/png", 0.92);
    }
  });
}
```

The client sends BOTH the video file and the extracted PNG to the server action as separate FormData fields (`file` + `frame`). The server uploads both to Storage.

Why two seeks (`onloadeddata` → set `currentTime` → `onseeked`)? Some codecs return a black frame at t=0; seeking to 0.1s forces a real frame decode. Tested across MP4 (H.264, H.265), WebM (VP8, VP9), MOV (H.264).

## 12.4 The vision analysis agent — `src/lib/agents/style-analyze.ts`

Add `style.analyze` to `JOB_TYPES` and `style` to `AGENTS` in `src/lib/constants.ts`. Register the handler in `src/lib/agents/registry.ts`.

The handler:
1. Marks the row `analysisStatus = "analyzing"`
2. Calls `generateStructured` with `model: MODELS.premium` (Opus 4.7 — best vision), `images: [ref.framePublicUrl]`
3. Returns a structured profile via `submit_style_profile` tool
4. Saves to `vision_analysis` JSON, marks `analysisStatus = "ready"`
5. On error: marks `"failed"` — owner can click "נתח שוב" to retry

The `generateStructured` helper (`src/lib/ai/generate.ts`) needs a new optional `images?: string[]` field that prepends image content blocks to the user message:

```ts
const userContent = opts.images?.length
  ? [
      ...opts.images.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
      { type: "text" as const, text: opts.userPrompt },
    ]
  : opts.userPrompt;
```

`source.type: "url"` is supported in Anthropic SDK 0.40+; you're on 0.68+ from Phase 3.

The structured schema:

```ts
{
  type: "object",
  properties: {
    palette:     { type: "array", items: { type: "string" }, description: "3-6 hex codes or precise color names" },
    lighting:    { type: "string", description: "Direction, hardness, color temperature, time-of-day" },
    framing:     { type: "string", description: "Shot size, angle, headroom" },
    composition: { type: "string", description: "Placement, depth, negative space" },
    mood:        { type: "string", description: "Emotional/atmospheric quality" },
    subject:     { type: "string", description: "Concise factual description" },
    motion:      { type: "string", description: "For video frames: inferred camera/subject motion" },
    notes:       { type: "string", description: "Distinctive style markers — grain, lens, grading, props" },
  },
  required: ["palette","lighting","framing","composition","mood","subject","notes"],
}
```

`maxTokens: 1200` is plenty for this schema.

Cost: ~$0.05 per analysis (one Opus 4.7 vision call with ~500 input tokens + ~500 output tokens). Per owner: 9 active refs × $0.05 = $0.45 lifetime. Cheap.

## 12.5 Style context helper — `src/lib/agents/style-context.ts`

```ts
export interface StyleReferenceContext {
  styleFragment: string;     // text to prepend to image-prompt
  frameUrls: string[];       // URLs to pass as reference_image_urls
  count: number;             // for activity-log summary
}

export async function buildStyleReferenceContext(
  userId: string,
  media: "image" | "video",
): Promise<StyleReferenceContext> {
  const refs = await prisma.styleReference.findMany({
    where: { userId, active: true, analysisStatus: "ready" },
    orderBy: { createdAt: "desc" },
    take: 9,                   // Kie + Nano Banana cap at 9 reference images
  });
  if (refs.length === 0) return { styleFragment: "", frameUrls: [], count: 0 };
  // ...distill analyses into a unified style guide fragment
  // Combine palettes, dedupe lighting/framing/composition/mood/motion notes.
  // Output as a structured block: "STYLE GUIDE (match these characteristics): ..."
}
```

The distilled fragment goes into the **user prompt** of `creative.ts`'s Haiku call, not the system prompt — keeps system-prompt caching intact across runs.

## 12.6 Wire creative.ts — image-first → animate for video

In `src/lib/agents/creative.ts`, after loading the post and settings:

```ts
const styleContext = await buildStyleReferenceContext(userId, media);

// Inject styleFragment into the Haiku call's userPrompt:
userPrompt: `הפוסט (${post.platform}):\n${truncate(post.content, 900)}${styleContext.styleFragment}`,
```

Then when calling the provider:

```ts
if (media === "video" && styleContext.frameUrls.length > 0 && (provider.name === "kie" || provider.name === "fal")) {
  // Image-first → animate.
  const keyframeModel = provider.name === "kie" ? "nano-banana-2" : "fal-ai/nano-banana-2";

  const keyframe = await provider.generate({
    prompt, seed: `${post.id}-keyframe`, platform: post.platform,
    model: keyframeModel, media: "image",
    referenceImageUrls: styleContext.frameUrls,
  });

  // Mirror keyframe to Storage — needed so Seedance can fetch a stable URL.
  const { mirrorToSupabase } = await import("@/lib/storage/mirror");
  const mirroredKeyframeUrl = await mirrorToSupabase(
    keyframe.imageUrl, `${post.id}-keyframe`, userId,
  );

  // Now generate video with first_frame_url.
  asset = await provider.generate({
    prompt, seed: post.id, platform: post.platform,
    model: chosenModel, media: "video",
    firstFrameUrl: mirroredKeyframeUrl,
  });
} else {
  // No refs (or image, or placeholder provider): standard text-to-image / text-to-video.
  asset = await provider.generate({
    prompt, seed: post.id, platform: post.platform,
    model: chosenModel, media,
    referenceImageUrls: styleContext.frameUrls.length > 0 && provider.name !== "placeholder"
      ? styleContext.frameUrls
      : undefined,
  });
}
```

**Why mirror the keyframe?** Kie's and FAL's CDN URLs are signed. The video API call happens ~30 seconds after image generation, but the signed URLs sometimes 403 between subsystems even within seconds. Storage URL never 403s.

**Why a synthetic seed for keyframe?** Avoids collisions with the post's normal asset row in `creative-assets/<userId>/<postId>.png`. The keyframe lives at `creative-assets/<userId>/<postId>-keyframe.png`.

## 12.7 Provider updates — `CreativeRequest` + Kie/FAL branches

Add to `CreativeRequest`:

```ts
firstFrameUrl?: string;         // for Seedance i2v
referenceImageUrls?: string[];  // for Nano Banana refs + Seedance multimodal-to-video
```

### Kie — `KieProvider.buildInput` (video branch)

Per [docs.kie.ai/market/bytedance/seedance-2](https://docs.kie.ai/market/bytedance/seedance-2), the **same model id** `bytedance/seedance-2` handles three modes:
- Text-to-video (default)
- Image-to-video: add `first_frame_url`
- Multimodal reference-to-video: add `reference_image_urls` (up to 9)

These are **mutually exclusive**. Pick the right one:

```ts
const input = { prompt, aspect_ratio, duration, generate_audio: false };
if (req.firstFrameUrl) {
  input.first_frame_url = req.firstFrameUrl;
} else if (req.referenceImageUrls?.length) {
  input.reference_image_urls = req.referenceImageUrls.slice(0, 9);
}
return input;
```

### Kie — `KieProvider.buildInput` (image branch)

Nano Banana on Kie accepts `image_urls` for multimodal-to-image:

```ts
if (model.includes("nano-banana")) {
  input.resolution = "1K";
  input.output_format = "png";
  if (req.referenceImageUrls?.length) {
    input.image_urls = req.referenceImageUrls.slice(0, 9);
  }
}
```

### FAL — `FalProvider`

FAL splits text-to-video and image-to-video into **separate model paths**. The provider auto-swaps when `firstFrameUrl` is present:

```ts
let model = req.model || this.defaultModel();
if ((req.media ?? "image") === "video" && req.firstFrameUrl &&
    model === "bytedance/seedance-2.0/text-to-video") {
  model = "bytedance/seedance-2.0/image-to-video";
}
```

Body for FAL i2v: `{prompt, image_url: req.firstFrameUrl, aspect_ratio, duration, generate_audio: false}`.

Body for FAL Nano Banana image with refs: add `image_urls: req.referenceImageUrls.slice(0, 9)`.

## 12.8 Upload server actions — `src/lib/actions/style-references.ts`

Four actions:
- `uploadStyleReferenceAction(formData)` — receives `file` + (for video) `frame` from the client; uploads both to the `style-references` bucket; creates a row; enqueues `style.analyze`
- `deleteStyleReferenceAction(id)` — drops from DB + best-effort cleanup of Storage files
- `toggleStyleReferenceAction(id, active)` — flips the active flag (lets the owner temporarily disable a ref without losing it)
- `reanalyzeStyleReferenceAction(id)` — re-enqueues `style.analyze` (for the "נתח שוב" button when analysis failed)

Critical pattern: **upload + DB row first, enqueue style.analyze second**. If the upload fails, the DB row is cleaned up via `delete` in the catch block. Enqueueing before upload would orphan jobs pointing to non-existent rows.

## 12.9 UI

- **Page:** `src/app/(app)/style-references/page.tsx` — server component, loads all refs, renders the uploader + a grid of `StyleReferenceCard`s. Sets `export const dynamic = "force-dynamic"` so the analysis status stays fresh as the worker processes refs.
- **Uploader:** client component with drag-drop, first-frame extraction (§12.3), optional label input. Toast feedback via `sonner`.
- **Card:** shows the asset (img for image, video for video), an `AnalysisBadge` (pending/analyzing/ready/failed), toggle Switch for `active`, delete button. Failed analyses get a "נתח שוב" retry button that calls `reanalyzeStyleReferenceAction`.

Add the nav link in `src/lib/nav.ts` under section "תוכן", icon `Wand2` from lucide-react. Hebrew label `סגנון ויזואלי` in `src/i18n/he.ts`.

## 12.10 Verify

```bash
# Smoke test 1 — bucket exists
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  "https://<PROJECT_REF>.supabase.co/storage/v1/object/public/style-references/health"
# Expected: 404 (no health file uploaded yet) — confirms the bucket route is live.

# Smoke test 2 — upload via UI
# 1. Navigate to /style-references
# 2. Drop an image — should appear immediately with status "מנתח..."
# 3. Wait ~30s — status flips to "נותח" with a green badge
# 4. Approve a new topic (or convert an existing post to video)
# 5. Watch the resulting asset — should reflect the style of the uploaded ref
```

**Cost expectation per owner:**
- One-time: $0.05 per uploaded reference (vision analysis). 9 refs = $0.45 total.
- Per content run: no extra cost. The style fragment adds ~150 tokens to the Haiku prompt (~$0.0002).
- Per video generation: image-first adds one Nano Banana 2 call (~$0.04) on top of the Seedance i2v call (~$0.30). Net: ~$0.34 per styled video instead of $0.30 per generic one. Modest premium.

## 12.11 Gotchas specific to this phase

| # | Symptom | Fix |
|---|---------|-----|
| 28 | Video upload extracts a black frame | Seek to 0.1s instead of t=0; some codecs (especially H.265) return black at exact frame 0. See `extractFirstFrame` two-event pattern in §12.3. |
| 29 | Vision analysis returns empty JSON / palette is `[]` | Image URL is signed/expired by the time Claude fetches it. Use the **mirrored Supabase Storage URL** (`framePublicUrl`), never the raw upload URL. |
| 30 | Seedance i2v returns "image not accessible" 30s after image-gen succeeded | Cross-API CDN URL handoff is fragile. Always mirror keyframe to Storage before passing to video API. (See §12.6.) |
| 31 | Owner uploads 10+ refs, system uses only the first 9 | Kie and Nano Banana both cap `image_urls` / `reference_image_urls` at 9. Document in UI; sort by recency so newest 9 win. |
| 32 | Page doesn't reflect "ready" status until manual refresh | Add `export const dynamic = "force-dynamic"` to the page. Worker updates DB ~15s after upload; without `force-dynamic`, Next.js serves a stale render. |
| 33 | Multimodal reference-to-video + first_frame_url sent together = Kie 400 | Per docs they're **mutually exclusive**. Prefer `first_frame_url` (image-first flow). See `KieProvider.buildInput` else-if pattern. |
| 34 | FAL Seedance i2v 404 even with a valid `image_url` | You forgot to swap the model id from `text-to-video` to `image-to-video`. FAL splits them; Kie doesn't. See `FalProvider.generate` early model-swap. |
| 35 | **Image uploads work, video uploads fail** with a generic "error" toast | Next.js Server Actions default body size limit is **1 MB**. Images are usually under that; videos never are. Add `experimental.serverActions.bodySizeLimit: "150mb"` to `next.config.ts`. (100MB video + ~5MB frame PNG fits comfortably.) The action throws "Body exceeded 1 MB limit" BEFORE `uploadStyleReferenceAction` even runs — so all the validation logic inside looks fine in code review. This applies to **any** phase that uploads via FormData (not just style-references). |

---

This is an optional phase — most clones won't need it until the owner complains about generic visuals. When they do, this is the pattern that works.
