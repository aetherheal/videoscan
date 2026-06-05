import { spawnSync } from "node:child_process";
import { logger } from "../utils/logger.js";

export interface Scene {
  index: number;
  start: number; // seconds
  end: number; // seconds
}

export function probeDuration(videoPath: string): number {
  const res = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  const dur = Number.parseFloat((res.stdout ?? "").trim());
  return Number.isFinite(dur) ? dur : 0;
}

// Detect scene-change cut points via ffmpeg's scene score, then build contiguous
// [start, end] ranges. Short clips with no detectable cuts collapse to a single
// scene spanning the whole video.
export function detectScenes(
  videoPath: string,
  duration: number,
  threshold = 0.3,
  minSceneSec = 0.8,
): Scene[] {
  const res = spawnSync(
    "ffmpeg",
    [
      "-i", videoPath,
      "-filter_complex", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null", "-",
    ],
    { encoding: "utf8" },
  );

  const stderr = res.stderr ?? "";
  const cutTimes: number[] = [];
  const re = /pts_time:([0-9]+\.?[0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number.parseFloat(m[1]!);
    if (Number.isFinite(t) && t > 0 && t < duration) cutTimes.push(t);
  }

  const boundaries = [0, ...cutTimes, duration]
    .filter((v, i, a) => i === 0 || v - a[i - 1]! >= 0.001)
    .sort((a, b) => a - b);

  const scenes: Scene[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    if (end - start < minSceneSec && scenes.length > 0) {
      // Fold a too-short tail into the previous scene rather than emit a sliver.
      scenes[scenes.length - 1]!.end = end;
      continue;
    }
    scenes.push({ index: scenes.length, start, end });
  }

  if (scenes.length === 0) scenes.push({ index: 0, start: 0, end: duration });

  logger.info("scene detection", { scenes: scenes.length, cuts: cutTimes.length });
  return scenes;
}
