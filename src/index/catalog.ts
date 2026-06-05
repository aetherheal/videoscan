import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { extractJson } from "../claude/json.js";
import { catalogResultSchema, type CatalogResult } from "../config/schema.js";
import type { Keyframe } from "./keyframes.js";

const SYSTEM = `You are the footage-cataloging layer of a video pipeline for Tune Clinic
(압구정튠의원), a premium aesthetic-dermatology brand under the "Chamakase" (차마카세)
identity. Clinic staff shoot WHATEVER — sit-down vlogs, doctor explanations, patient
consultations, procedures, plain B-roll — and drop it in. Your job: (1) DISCRIMINATE
what kind of clip it is, and (2) describe each scene so the footage can be SEARCHED
and REUSED to compose vlogs and viral shorts across many videos.

Inputs per scene: a time range, one keyframe image, and any overlapping speech
transcript. You are also given the clip's full transcript and whether speech was
detected. Judge each scene primarily from the IMAGE — much footage has no speech and
its value is purely visual. Do NOT invent speech; the transcript is authoritative and
supplied separately, so you do not need to reproduce it.

content_type (classify the WHOLE clip): vlog | talking_head | consultation |
procedure | interview | b_roll | mixed | other. Use both the visuals and whether
there is real speech (a silent treatment close-up is "procedure"/"b_roll", a person
narrating to camera is "vlog"/"talking_head").

Per scene:
- shot_type: aerial | exterior | interior | talking_head | procedure | product | b_roll | other
- setting: where it appears shot
- description: what is on screen, framing, motion — one or two sentences an editor can skim
- people: visible subjects ([] if none)
- is_b_roll: true if no usable speech / visual-only
- tags: free-form search terms (location, subject, mood, color, objects)
- usable_for: composition hints, e.g. "vlog-establishing", "short-hook-bg", "transition"

No medical or efficacy claims. Return STRICT JSON only — no prose, no markdown, no
backticks — matching exactly:

{
  "summary": "one line describing what this whole clip is",
  "content_type": "...",
  "scenes": [
    { "index": number, "start": number, "end": number, "shot_type": "...",
      "setting": string, "description": string, "people": [string],
      "is_b_roll": boolean, "spoken_excerpt": string | null,
      "tags": [string], "usable_for": [string] }
  ]
}
Keep "index", "start", "end", and "spoken_excerpt" exactly as given in the input.`;

function mediaTypeFor(path: string): "image/jpeg" | "image/png" {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

export interface CatalogInput {
  sourceFile: string;
  duration: number;
  hasSpeech: boolean;
  transcript: string;
  scenes: Array<{ keyframe: Keyframe; spokenExcerpt: string | null }>;
}

export async function catalogScenes(input: CatalogInput): Promise<CatalogResult> {
  const { anthropicApiKey, model } = env();
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const header = {
    source_file: basename(input.sourceFile),
    duration: Number(input.duration.toFixed(3)),
    has_speech: input.hasSpeech,
    full_transcript: input.transcript || null,
    scenes: input.scenes.map(({ keyframe, spokenExcerpt }) => ({
      index: keyframe.scene.index,
      start: Number(keyframe.scene.start.toFixed(3)),
      end: Number(keyframe.scene.end.toFixed(3)),
      spoken_excerpt: spokenExcerpt,
    })),
  };

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `Catalog this footage. Classify content_type and describe each scene. ` +
        `Keep index/start/end/spoken_excerpt verbatim:\n` +
        JSON.stringify(header, null, 2) +
        `\n\nThe keyframes follow, in scene-index order:`,
    },
  ];

  for (const { keyframe } of input.scenes) {
    const data = readFileSync(keyframe.path).toString("base64");
    content.push({
      type: "text",
      text: `scene ${keyframe.scene.index} @ ${keyframe.atSec.toFixed(1)}s:`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaTypeFor(keyframe.path), data },
    });
  }

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const raw: unknown = JSON.parse(extractJson(text));
  const result = catalogResultSchema.parse(raw);

  logger.info("catalog complete", {
    source_file: basename(input.sourceFile),
    content_type: result.content_type,
    scenes: result.scenes.length,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  });

  return result;
}
