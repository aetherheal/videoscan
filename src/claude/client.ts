import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clipSpecSchema, type ClipManifest } from "../config/schema.js";
import { providerFor } from "../providers/index.js";
import type { JsonSchema, ProviderUsage } from "../providers/types.js";
import { logger } from "../utils/logger.js";
import { extractJson } from "./json.js";
import type { VideoContext, WhisperTranscript } from "../types.js";

const SYSTEM_PROMPT_PATH = resolve(process.cwd(), "prompts/layer4-system.txt");

function loadSystemPrompt(): string {
  return readFileSync(SYSTEM_PROMPT_PATH, "utf8");
}

export interface JudgeResult {
  clips: ClipManifest;
  model: string;
  usage?: ProviderUsage;
}

const timecodeSchema: JsonSchema = {
  type: "string",
  pattern: "^\\d{2}:\\d{2}:\\d{2}\\.\\d{3}$",
};

// The local Zod validation below remains the source of truth. This equivalent
// JSON Schema constrains Codex CLI's final response before it reaches us.
const clipManifestJsonSchema: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      clip_id: { type: "string" },
      source_file: { type: "string" },
      language: { type: "string", enum: ["ko", "en", "mixed"] },
      start: timecodeSchema,
      end: timecodeSchema,
      duration_sec: { type: "number", exclusiveMinimum: 0 },
      hook_type: {
        type: "string",
        enum: ["contrarian", "curiosity_gap", "named_stakes", "specific_number"],
      },
      hook_overlay: { type: "string" },
      captions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: timecodeSchema,
            end: timecodeSchema,
            text: { type: "string" },
          },
          required: ["start", "end", "text"],
          additionalProperties: false,
        },
      },
      payoff_line: { type: "string" },
      shareability_driver: {
        type: "string",
        enum: ["myth_correction", "insider_authority", "counterintuitive", "specificity"],
      },
      virality_score: { type: "number", minimum: 1, maximum: 10 },
      virality_rationale: { type: "string" },
      brand_safety: { type: "string", enum: ["pass", "review"] },
      brand_safety_reason: { type: ["string", "null"] },
      reframe_advice: { type: "string", enum: ["speaker-centered", "manual-review"] },
    },
    required: [
      "clip_id",
      "source_file",
      "language",
      "start",
      "end",
      "duration_sec",
      "hook_type",
      "hook_overlay",
      "captions",
      "payoff_line",
      "shareability_driver",
      "virality_score",
      "virality_rationale",
      "brand_safety",
      "brand_safety_reason",
      "reframe_advice",
    ],
    additionalProperties: false,
  },
};

// Layer 4 — send one transcript to Claude, get back a validated clip manifest.
export async function judgeTranscript(
  transcript: WhisperTranscript,
  context?: VideoContext,
): Promise<JudgeResult> {
  const provider = providerFor("judge");

  const userPayload = {
    source_file: transcript.source_file,
    context: context ?? null,
    transcript,
  };

  // Streamed: long transcripts + adaptive thinking can push generation past the
  // SDK's 10-minute non-streaming ceiling. Streaming avoids that hard error.
  const response = await provider.generateJson({
      // Long, dense transcripts made *adaptive* thinking spiral — it spent the
      // entire budget thinking and returned no text (stop_reason=max_tokens).
      // Medium effort keeps that behavior bounded while preserving judgment quality.
      // max_tokens is a ceiling, not spend; the headroom is for the thinking +
      // manifest of a 12-minute talker.
    maxTokens: 42000,
    schema: clipManifestJsonSchema,
    system: { text: loadSystemPrompt(), cache: true },
    prompt: JSON.stringify(userPayload),
  });

  const text = response.text;

  if (!text.trim()) {
    // Empty text almost always means thinking consumed the whole token budget.
    throw new Error(
      `Layer 4 returned no text (stop_reason=${response.stopReason}, ` +
        `blocks=[${response.contentBlockTypes?.join(", ") ?? "unknown"}], ` +
        `output_tokens=${response.usage?.outputTokens ?? "unknown"})`,
    );
  }

  const raw: unknown = JSON.parse(extractJson(text));
  if (!Array.isArray(raw)) {
    throw new Error(`Layer 4 did not return a JSON array (got ${typeof raw})`);
  }

  // Validate per-clip so one malformed entry (e.g. the model occasionally puts a
  // shareability_driver value like "specificity" into hook_type) doesn't discard
  // the whole video's worth of good clips — drop just the bad one and log it.
  const clips: ClipManifest = [];
  let dropped = 0;
  for (const item of raw) {
    const result = clipSpecSchema.safeParse(item);
    if (result.success) {
      clips.push(result.data);
    } else {
      dropped++;
      logger.warn("layer4 dropped invalid clip", {
        source_file: transcript.source_file,
        issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
  }

  logger.info("layer4 judged transcript", {
    source_file: transcript.source_file,
    clips: clips.length,
    dropped,
    model: provider.model,
    ...(response.usage
      ? {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
        }
      : {}),
  });

  return {
    clips,
    model: provider.model,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}
