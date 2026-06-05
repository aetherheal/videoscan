import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./scene-detect.js";

export interface Keyframe {
  scene: Scene;
  path: string;
  atSec: number;
}

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
        "-vf", "scale=768:-2",
        "-q:v", "4",
        path,
      ],
      { stdio: "ignore" },
    );
    if (existsSync(path)) frames.push({ scene, path, atSec });
  }

  return frames;
}
