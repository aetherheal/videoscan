import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { transcribe } from "../layers/layer3-asr.js";
import { detectScenes, probeDuration } from "./scene-detect.js";
import { extractKeyframes } from "./keyframes.js";
import { fullTranscriptText, spokenExcerptFor } from "./transcript.js";
import { catalogScenes } from "./catalog.js";
import { logger } from "../utils/logger.js";
import { footageIndexSchema, type FootageIndex } from "../config/schema.js";
import type { WhisperTranscript } from "../types.js";

// Phase 1 — build a content catalog (footage-index.json) for one video:
//   ASR (optional) + scene-detect → keyframes → Claude vision → tagged scenes.
//
// Usage:
//   pnpm index <video-file> [--no-asr]
//
// --no-asr skips transcription (faster; fine for pure B-roll). Visual cataloging
// still runs, so B-roll is captured either way.

export interface BuildIndexOptions {
  asr?: boolean;
  outRoot?: string;
}

export async function buildIndex(
  videoPath: string,
  opts: BuildIndexOptions = {},
): Promise<FootageIndex> {
  const asr = opts.asr ?? true;
  const stem = basename(videoPath, extname(videoPath));
  const outDir = join(opts.outRoot ?? resolve(process.cwd(), "outputs"), stem);
  mkdirSync(outDir, { recursive: true });

  const duration = probeDuration(videoPath);
  if (duration <= 0) throw new Error(`Could not read duration for ${videoPath}`);

  let transcript: WhisperTranscript | null = null;
  if (asr) {
    transcript = await transcribe(videoPath);
    writeFileSync(join(outDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  }

  const transcriptText = fullTranscriptText(transcript);
  const hasSpeech = transcriptText.length > 0;

  const scenes = detectScenes(videoPath, duration);
  const keyframes = extractKeyframes(videoPath, scenes, join(outDir, "keyframes"));
  if (keyframes.length === 0) throw new Error("No keyframes could be extracted");

  const catalog = await catalogScenes({
    sourceFile: videoPath,
    duration,
    hasSpeech,
    transcript: transcriptText,
    scenes: keyframes.map((keyframe) => ({
      keyframe,
      spokenExcerpt: spokenExcerptFor(transcript, keyframe.scene),
    })),
  });

  // Merge code-owned (deterministic) fields with Claude's classification.
  const index: FootageIndex = footageIndexSchema.parse({
    ...catalog,
    source_file: basename(videoPath),
    duration,
    language: transcript?.language ?? "unknown",
    has_speech: hasSpeech,
    transcript: transcriptText,
  });

  const outPath = join(outDir, "footage-index.json");
  writeFileSync(outPath, JSON.stringify(index, null, 2));
  logger.info("footage index written", {
    outPath,
    content_type: index.content_type,
    has_speech: index.has_speech,
    scenes: index.scenes.length,
  });
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const video = argv.find((a) => !a.startsWith("--"));
  if (!video) {
    logger.error("usage: pnpm index <video-file> [--no-asr]");
    process.exit(1);
  }
  buildIndex(video, { asr: !argv.includes("--no-asr") })
    .then((index) => {
      process.stdout.write(JSON.stringify(index, null, 2) + "\n");
    })
    .catch((err: unknown) => {
      logger.error("index build failed", { error: String(err) });
      process.exit(1);
    });
}
