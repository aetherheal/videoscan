import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./scene-detect.js";

export interface Keyframe {
  scene: Scene;
  path: string;
  atSec: number;
}

// Long edge of the extracted keyframe, in pixels. This is the single knob that
// decides how much the catalog can actually see, and it dominates catalog cost —
// image tokens scale with area, so doubling this roughly quadruples input spend.
// 1568 is the sweet spot: Sonnet 5 accepts up to 2576, but scene-level
// recognition (shot type, setting, b-roll vs. talking head) saturates well below
// that, and 2576 would ~11x the token bill of the old 768 across a 650-clip
// library. Raise it only if the catalog needs to read on-screen text.
const KEYFRAME_LONG_EDGE = 1568;

// Grab one representative frame per scene (the midpoint), downscaled to keep the
// vision payload small. Returns only scenes whose frame extracted successfully.
export function extractKeyframes(
  videoPath: string,
  scenes: Scene[],
  outDir: string,
): Keyframe[] {
  mkdirSync(outDir, { recursive: true });
  const frames: Keyframe[] = [];

  for (const scene of scenes) {
    const atSec = scene.start + (scene.end - scene.start) / 2;
    const path = join(outDir, `scene_${String(scene.index).padStart(3, "0")}.jpg`);
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-ss", atSec.toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", `scale=${KEYFRAME_LONG_EDGE}:-2`,
        "-q:v", "4",
        path,
      ],
      { stdio: "ignore" },
    );
    if (existsSync(path)) frames.push({ scene, path, atSec });
  }

  return frames;
}
