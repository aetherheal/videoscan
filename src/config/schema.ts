import { z } from "zod";

// HH:MM:SS.mmm — the timecode format Layer 4 must emit and Layer 5 (ffmpeg) consumes.
const timecode = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}\.\d{3}$/, "expected HH:MM:SS.mmm");

export const captionSchema = z.object({
  start: timecode,
  end: timecode,
  text: z.string(),
});

// The clip specification returned by Layer 4. This is the build manifest for ffmpeg.
export const clipSpecSchema = z.object({
  clip_id: z.string(),
  source_file: z.string(),
  language: z.enum(["ko", "en", "mixed"]),
  start: timecode,
  end: timecode,
  duration_sec: z.number().positive(),
  hook_type: z.enum([
    "contrarian",
    "curiosity_gap",
    "named_stakes",
    "specific_number",
  ]),
  hook_overlay: z.string(),
  captions: z.array(captionSchema),
  payoff_line: z.string(),
  shareability_driver: z.enum([
    "myth_correction",
    "insider_authority",
    "counterintuitive",
    "specificity",
  ]),
  virality_score: z.number().min(1).max(10),
  virality_rationale: z.string(),
  brand_safety: z.enum(["pass", "review"]),
  brand_safety_reason: z.string().nullable(),
  reframe_advice: z.enum(["speaker-centered", "manual-review"]),
});

// Layer 4 returns a single array, sorted by virality_score descending.
export const clipManifestSchema = z.array(clipSpecSchema);

export type Caption = z.infer<typeof captionSchema>;
export type ClipSpec = z.infer<typeof clipSpecSchema>;
export type ClipManifest = z.infer<typeof clipManifestSchema>;

// A ClipSpec is routed to the human queue (never auto-rendered) when either holds.
export function needsHumanReview(clip: ClipSpec): boolean {
  return clip.reframe_advice === "manual-review" || clip.brand_safety === "review";
}

// ── Phase 1: footage content catalog ────────────────────────────────────────
// One entry per detected scene in a source video. This is what makes footage
// reusable across videos: each scene is described visually (so B-roll with no
// speech is still catalogued) and tagged for later cross-video composition.

export const shotTypeEnum = z.enum([
  "aerial", // drone / overhead
  "exterior", // building / outdoor establishing
  "interior", // clinic rooms, lobby
  "talking_head", // a person speaking to camera
  "procedure", // treatment / clinical action
  "product", // device / product close-up
  "b_roll", // generic supporting footage
  "other",
]);

export const sceneDescriptorSchema = z.object({
  index: z.number().int().nonnegative(),
  start: z.number().nonnegative(), // seconds
  end: z.number().nonnegative(), // seconds
  shot_type: shotTypeEnum,
  setting: z.string(), // where this appears to be shot
  description: z.string(), // what is visible — for the catalog reader/composer
  people: z.array(z.string()), // who/what subjects are present ([] if none)
  is_b_roll: z.boolean(), // true = no usable speech, visual-only material
  spoken_excerpt: z.string().nullable(), // transcript text overlapping this scene
  tags: z.array(z.string()), // free-form, for cross-video search
  usable_for: z.array(z.string()), // e.g. "vlog-establishing", "short-hook"
});

// Clip-level "what kind of footage is this" — the AI's first-pass discrimination
// so staff can shoot anything and it gets sorted automatically.
export const contentTypeEnum = z.enum([
  "vlog", // person narrating to camera, casual
  "talking_head", // sit-down explainer / piece-to-camera
  "consultation", // doctor–patient conversation
  "procedure", // treatment in progress (often little/no speech)
  "interview", // Q&A between people
  "b_roll", // supporting visuals, no speech
  "mixed", // multiple of the above within one clip
  "other",
]);

// What Claude returns from the vision+transcript pass (the "감별" judgment).
export const catalogResultSchema = z.object({
  summary: z.string(), // one-line "what this clip is"
  content_type: contentTypeEnum,
  scenes: z.array(sceneDescriptorSchema),
});

// The full catalog entry written to disk. content_type/summary/scenes come from
// Claude; source_file/duration/language/has_speech/transcript are code-owned
// (deterministic) so the transcribed text is always authoritative, never a model
// paraphrase.
export const footageIndexSchema = catalogResultSchema.extend({
  source_file: z.string(),
  duration: z.number().nonnegative(),
  language: z.string(),
  has_speech: z.boolean(),
  transcript: z.string(), // full "받아쓰기"; "" when the clip has no speech
});

export type ShotType = z.infer<typeof shotTypeEnum>;
export type ContentType = z.infer<typeof contentTypeEnum>;
export type SceneDescriptor = z.infer<typeof sceneDescriptorSchema>;
export type CatalogResult = z.infer<typeof catalogResultSchema>;
export type FootageIndex = z.infer<typeof footageIndexSchema>;
