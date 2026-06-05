import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../utils/logger.js";
import { needsHumanReview, type ClipSpec } from "../config/schema.js";

// Layer 5 — execute one ClipSpec with ffmpeg:
//   -ss start -to end cut → 9:16 crop (speaker-centered) → caption burn-in.
// Clips flagged for human review are NOT auto-rendered.
//
// Caption burn-in and a real speaker-tracking crop are intentionally left as a
// TODO: the crop here is a centered 9:16 cover crop. Wire a face/speaker
// detector (e.g. an autocrop pass) before treating this as production.

export interface RenderOptions {
  outputDir: string;
  dryRun?: boolean;
}

function timecodeToSeconds(tc: string): number {
  const [hh, mm, rest] = tc.split(":");
  return Number(hh) * 3600 + Number(mm) * 60 + Number(rest);
}

export interface RenderOutcome {
  clip_id: string;
  status: "rendered" | "queued-for-review" | "dry-run" | "error";
  output?: string;
  reason?: string;
}

export function renderClip(
  clip: ClipSpec,
  videoPath: string,
  opts: RenderOptions,
): RenderOutcome {
  if (needsHumanReview(clip)) {
    logger.warn("layer5 routing to human queue", {
      clip_id: clip.clip_id,
      brand_safety: clip.brand_safety,
      reframe_advice: clip.reframe_advice,
    });
    return { clip_id: clip.clip_id, status: "queued-for-review" };
  }

  mkdirSync(opts.outputDir, { recursive: true });
  const output = join(opts.outputDir, `${clip.clip_id}.mp4`);

  const ss = timecodeToSeconds(clip.start).toFixed(3);
  const to = timecodeToSeconds(clip.end).toFixed(3);

  // Centered 9:16 cover crop. min(iw,ih*9/16) keeps the full height and crops width.
  const vf = "crop='min(iw,ih*9/16)':ih,scale=1080:1920";

  const args = [
    "-y",
    "-ss", ss,
    "-to", to,
    "-i", videoPath,
    "-vf", vf,
    "-c:a", "aac",
    "-movflags", "+faststart",
    output,
  ];

  if (opts.dryRun) {
    logger.info("layer5 dry-run", { clip_id: clip.clip_id, cmd: `ffmpeg ${args.join(" ")}` });
    return { clip_id: clip.clip_id, status: "dry-run", output };
  }

  const result = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : `ffmpeg exited ${result.status}`;
    logger.error("layer5 render failed", { clip_id: clip.clip_id, reason });
    return { clip_id: clip.clip_id, status: "error", reason };
  }

  logger.info("layer5 rendered", { clip_id: clip.clip_id, output });
  return { clip_id: clip.clip_id, status: "rendered", output };
}

// CLI: pnpm render <manifest.json> <video-file>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , manifestPath, videoPath] = process.argv;
  if (!manifestPath || !videoPath) {
    logger.error("usage: tsx src/layers/layer5-render.ts <manifest.json> <video-file>");
    process.exit(1);
  }
  const { readFileSync } = await import("node:fs");
  const clips = JSON.parse(readFileSync(manifestPath, "utf8")) as ClipSpec[];
  const outputDir = resolve(process.cwd(), "outputs");
  for (const clip of clips) {
    renderClip(clip, videoPath, { outputDir, dryRun: !existsSync("/usr/bin/ffmpeg") && process.argv.includes("--dry-run") });
  }
}
