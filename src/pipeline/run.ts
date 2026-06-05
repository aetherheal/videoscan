import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { transcribe } from "../layers/layer3-asr.js";
import { judgeTranscript } from "../layers/layer4-judge.js";
import { renderClip } from "../layers/layer5-render.js";
import { logger } from "../utils/logger.js";
import { needsHumanReview } from "../config/schema.js";

// End-to-end driver for a single source video:
//   Layer 3 (ASR) → Layer 4 (Claude judgment) → Layer 5 (ffmpeg render).
//
// Usage:
//   pnpm scan <video-file> [--dry-run]
//
// --dry-run runs Layers 3 and 4 for real (so you see the ranked clips and token
// cost) but does not invoke ffmpeg.

interface Args {
  video: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const video = positional[0];
  if (!video) {
    logger.error("usage: pnpm scan <video-file> [--dry-run]");
    process.exit(1);
  }
  return { video, dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { video, dryRun } = parseArgs(process.argv.slice(2));
  const stem = basename(video, extname(video));
  const outputDir = resolve(process.cwd(), "outputs", stem);
  mkdirSync(outputDir, { recursive: true });

  // Layer 3
  const transcript = await transcribe(video);
  writeFileSync(
    join(outputDir, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );

  // Layer 4
  const { clips, model } = await judgeTranscript(transcript, {
    title: stem,
  });
  writeFileSync(
    join(outputDir, "manifest.json"),
    JSON.stringify(clips, null, 2),
  );

  if (clips.length === 0) {
    logger.info("layer4 returned no clips above threshold — nothing to render", {
      source: stem,
      model,
    });
    return;
  }

  // Layer 5
  const auto = clips.filter((c) => !needsHumanReview(c));
  const review = clips.filter(needsHumanReview);
  logger.info("manifest summary", {
    total: clips.length,
    auto_render: auto.length,
    human_review: review.length,
    top_score: clips[0]?.virality_score,
  });

  for (const clip of clips) {
    renderClip(clip, video, { outputDir, dryRun });
  }

  logger.info("scan complete", { source: stem, outputDir });
}

main().catch((err: unknown) => {
  logger.error("pipeline failed", { error: String(err) });
  process.exit(1);
});
