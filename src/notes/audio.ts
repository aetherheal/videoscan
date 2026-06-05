import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

// Extract just the audio to a small 16 kHz mono WAV (what Whisper wants). This
// reads the source once (downloading it from Drive into Drive's cache), but the
// artifact WE create is tiny — ~2 MB/min — and gets deleted after transcription,
// so our pipeline never leaves a large local copy behind.
export function extractAudio(videoPath: string, scratchDir: string): string {
  mkdirSync(scratchDir, { recursive: true });
  const out = join(scratchDir, `${basename(videoPath, extname(videoPath))}.wav`);
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
    { stdio: "ignore" },
  );
  if (res.error || res.status !== 0) {
    throw new Error(`audio extraction failed: ${res.error?.message ?? `ffmpeg exit ${res.status}`}`);
  }
  return out;
}
