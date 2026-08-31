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

// Longest scene the catalog will emit. A search result has to be usable as an
// editing pointer — "clip.mp4 @ 00:00–13:18" tells an editor nothing — so any
// stretch longer than this gets subdivided even when no visual cut exists.
const MAX_SCENE_SEC = 30;

export interface DetectSceneOptions {
  threshold?: number;
  minSceneSec?: number;
  maxSceneSec?: number;
  /**
   * Transcript segment start times, used to subdivide long continuous takes at
   * natural speech pauses instead of arbitrary clock intervals.
   */
  speechBoundaries?: number[];
}

// Subdivide one over-long span, preferring speech boundaries near the target
// length and falling back to even splits when there is no speech to align to.
function subdivide(
  start: number,
  end: number,
  maxSceneSec: number,
  speechBoundaries: number[],
): Array<{ start: number; end: number }> {
  const span = end - start;
  if (span <= maxSceneSec) return [{ start, end }];

  const inner = speechBoundaries
    .filter((t) => t > start + 1 && t < end - 1)
    .sort((a, b) => a - b);

  const cuts: number[] = [];
  let cursor = start;
  while (end - cursor > maxSceneSec) {
    const target = cursor + maxSceneSec;
    // Nearest speech pause at or before the target keeps a sentence intact;
    // require real forward progress so we cannot loop on a clustered boundary.
    const candidate = [...inner].reverse().find((t) => t <= target && t > cursor + 1);
    const cut = candidate ?? target;
    cuts.push(cut);
    cursor = cut;
  }

  const bounds = [start, ...cuts, end];
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push({ start: bounds[i]!, end: bounds[i + 1]! });
  }
  return out;
}

// Detect scene-change cut points via ffmpeg's scene score, then build contiguous
// [start, end] ranges.
//
// This footage is mostly raw DJI Pocket takes — continuous, unedited, so there
// are genuinely NO visual cuts to find (measured: 0 cuts in a 13-minute clip at
// threshold 0.3, and lowering the threshold only surfaces camera movement, not
// real boundaries). Cut detection alone therefore collapsed every clip to one
// scene, which makes the catalog useless for search. Long spans are subdivided
// below so the unit of search stays an editable moment.
export function detectScenes(
  videoPath: string,
  duration: number,
  opts: DetectSceneOptions = {},
): Scene[] {
  const threshold = opts.threshold ?? 0.3;
  const minSceneSec = opts.minSceneSec ?? 0.8;
  const maxSceneSec = opts.maxSceneSec ?? MAX_SCENE_SEC;
  const speechBoundaries = opts.speechBoundaries ?? [];
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

  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    if (end - start < minSceneSec && spans.length > 0) {
      // Fold a too-short tail into the previous span rather than emit a sliver.
      spans[spans.length - 1]!.end = end;
      continue;
    }
    spans.push({ start, end });
  }

  if (spans.length === 0) spans.push({ start: 0, end: duration });

  const scenes: Scene[] = [];
  for (const span of spans) {
    for (const part of subdivide(span.start, span.end, maxSceneSec, speechBoundaries)) {
      scenes.push({ index: scenes.length, start: part.start, end: part.end });
    }
  }

  logger.info("scene detection", {
    scenes: scenes.length,
    cuts: cutTimes.length,
    from_cuts: spans.length,
    subdivided: scenes.length > spans.length,
    aligned_to_speech: speechBoundaries.length > 0,
  });
  return scenes;
}
