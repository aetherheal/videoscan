import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { extractJson } from "../claude/json.js";
import { logger } from "../utils/logger.js";

const SYSTEM = `You process transcripts of clinic / company footage for Tune Clinic
(압구정튠의원) and its sister venture Aetherheal. Footage is spoken in Korean or English.
Produce a BILINGUAL note (English + Korean), for staff skimming a folder of many videos.

Be faithful to the transcript — do NOT invent facts, and do NOT add medical or efficacy
claims that aren't in the source. If the transcript is fragmentary or noisy, say so
briefly rather than guessing. Keep uncertain/unclear terms in brackets (e.g. "[lacing?]"
/ "[라싱?]"). Translate faithfully between the two languages.

Return STRICT JSON only — no prose, no markdown, no backticks — matching exactly:

{
  "summary_en": "English summary:\\nOne-line: <one sentence>\\n\\nKey points:\\n- <bullet>\\n- <bullet>\\n\\nTopic tags: <comma-separated>\\nSpeakers/Language: <who speaks, source language>",
  "summary_ko": "위 요약의 한국어판 (동일 구조: 한 줄 요약 / 핵심 내용 불릿 / 주제 태그 / 화자·언어)",
  "transcript_en": "the full spoken content in ENGLISH (verbatim if source is English, else a faithful translation)",
  "transcript_ko": "전체 발화 내용의 한국어판 (원문이 한국어면 그대로, 영어면 충실히 번역)"
}`;

const resultSchema = z.object({
  summary_en: z.string(),
  summary_ko: z.string(),
  transcript_en: z.string(),
  transcript_ko: z.string(),
});

export interface NoteContent {
  summaryEn: string;
  summaryKo: string;
  transcriptEn: string;
  transcriptKo: string;
}

const NO_SPEECH: NoteContent = {
  summaryEn:
    "One-line: No speech detected (appears to be a visual-only / B-roll clip).\n\n" +
    "Key points:\n- No spoken audio — likely B-roll / silent footage.\n\n" +
    "Topic tags: silent, b-roll\nSpeakers/Language: none",
  summaryKo:
    "한 줄 요약: 음성이 감지되지 않았습니다 (시각 전용 / B-roll 클립으로 보입니다).\n\n" +
    "핵심 내용:\n- 말소리 없음 — B-roll/무음 영상으로 추정.\n\n" +
    "주제 태그: 무음, b-roll\n화자/언어: 없음",
  transcriptEn: "",
  transcriptKo: "",
};

// Summarize + translate one transcript into a bilingual (EN/KO) note. For
// speechless clips we skip the API call and return a fixed bilingual note.
export async function summarizeTranscript(
  meta: { filename: string; durationSec: number; language: string },
  transcript: string,
): Promise<NoteContent> {
  if (transcript.trim().length === 0) return NO_SPEECH;

  const { anthropicApiKey, model } = env();
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
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

  return {
    summaryEn: parsed.summary_en,
    summaryKo: parsed.summary_ko,
    transcriptEn: parsed.transcript_en,
    transcriptKo: parsed.transcript_ko,
  };
}
