import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { extractJson } from "../claude/json.js";
import { logger } from "../utils/logger.js";

const SYSTEM = `You process transcripts of clinic / company footage for Tune Clinic
(압구정튠의원) and its sister venture Aetherheal. The footage is often spoken in Korean.
Produce an ENGLISH summary and an ENGLISH translation, for an internal reader skimming
a folder of many videos to find usable content.

Be faithful to the transcript — do NOT invent facts, and do NOT add medical or efficacy
claims that aren't in the source. If the transcript is fragmentary or noisy, say so
briefly rather than guessing. For the translation, translate what is actually said; keep
uncertain or unclear terms in brackets (e.g. "[lacing?]").

Return STRICT JSON only — no prose, no markdown, no backticks — matching exactly:

{
  "summary": "multi-line ENGLISH summary in this shape:\\nOne-line: <one sentence>\\n\\nKey points:\\n- <bullet>\\n- <bullet>\\n\\nTopic tags: <comma-separated>\\nSpeakers/Language: <who seems to speak, and source language>",
  "english_transcript": "a faithful ENGLISH translation of everything spoken, as flowing text"
}`;

const resultSchema = z.object({
  summary: z.string(),
  english_transcript: z.string(),
});

export interface NoteContent {
  summary: string; // English
  englishTranscript: string; // English translation of the speech
}

// Summarize + translate one transcript into English. For speechless clips we
// skip the API call entirely and return a fixed English note.
export async function summarizeTranscript(
  meta: { filename: string; durationSec: number; language: string },
  transcript: string,
): Promise<NoteContent> {
  if (transcript.trim().length === 0) {
    return {
      summary:
        "One-line: No speech detected (appears to be a visual-only / B-roll clip).\n\n" +
        "Key points:\n- No spoken audio — likely B-roll / silent footage.\n\n" +
        "Topic tags: silent, b-roll\nSpeakers/Language: none",
      englishTranscript: "",
    };
  }

  const { anthropicApiKey, model } = env();
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `File: ${meta.filename}\nLength: ${meta.durationSec.toFixed(0)}s\n` +
          `Detected language: ${meta.language}\n\nTranscript (verbatim):\n${transcript}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = resultSchema.parse(JSON.parse(extractJson(text)));

  logger.info("summarized", {
    filename: meta.filename,
    chars: transcript.length,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  });

  return { summary: parsed.summary, englishTranscript: parsed.english_transcript };
}
