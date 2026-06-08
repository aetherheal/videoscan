import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { clipSpecSchema, type ClipManifest } from "../config/schema.js";
import { extractJson } from "./json.js";
import type { VideoContext, WhisperTranscript } from "../types.js";

const SYSTEM_PROMPT_PATH = resolve(process.cwd(), "prompts/layer4-system.txt");

function loadSystemPrompt(): string {
  return readFileSync(SYSTEM_PROMPT_PATH, "utf8");
}

export interface JudgeResult {
  clips: ClipManifest;
  model: string;
  usage: Anthropic.Usage;
}

// Layer 4 — send one transcript to Claude, get back a validated clip manifest.
export async function judgeTranscript(
  transcript: WhisperTranscript,
  context?: VideoContext,
): Promise<JudgeResult> {
  const { anthropicApiKey, model } = env();
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const userPayload = {
    source_file: transcript.source_file,
    context: context ?? null,
    transcript,
  };

  // Streamed: long transcripts + adaptive thinking can push generation past the
  // SDK's 10-minute non-streaming ceiling. Streaming avoids that hard error.
  const response = await client.messages
    .stream({
      model,
      // Long, dense transcripts made *adaptive* thinking spiral — it spent the
      // entire budget thinking and returned no text (stop_reason=max_tokens).
      // Cap thinking so the model must commit, leaving ample room for the clips.
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 8000 },
      system: [
        {
          type: "text",
          text: loadSystemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: JSON.stringify(userPayload),
        },
      ],
    })
    .finalMessage();

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) {
    // Empty text almost always means thinking consumed the whole token budget.
    throw new Error(
      `Layer 4 returned no text (stop_reason=${response.stop_reason}, ` +
        `blocks=[${response.content.map((b) => b.type).join(", ")}], ` +
        `output_tokens=${response.usage.output_tokens})`,
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
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  });

  return { clips, model, usage: response.usage };
}
