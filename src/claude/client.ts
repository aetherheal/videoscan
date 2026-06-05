import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { clipManifestSchema, type ClipManifest } from "../config/schema.js";
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

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
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
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const raw: unknown = JSON.parse(extractJson(text));
  const clips = clipManifestSchema.parse(raw);

  logger.info("layer4 judged transcript", {
    source_file: transcript.source_file,
    clips: clips.length,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  });

  return { clips, model, usage: response.usage };
}
