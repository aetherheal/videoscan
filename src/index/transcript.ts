import type { WhisperTranscript } from "../types.js";
import type { Scene } from "./scene-detect.js";

// The full "받아쓰기" — every spoken segment joined. Empty string when the clip
// has no speech (with VAD on, silent footage yields zero segments, so this is ""
// rather than hallucinated text).
export function fullTranscriptText(transcript: WhisperTranscript | null): string {
  if (!transcript) return "";
  return transcript.segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Collect transcript text whose words overlap a scene's [start, end] window.
// Returns null when the scene has no speech (typical for B-roll) — the caller
// uses that to mark the scene visual-only.
export function spokenExcerptFor(
  transcript: WhisperTranscript | null,
  scene: Scene,
): string | null {
  if (!transcript) return null;
  const parts: string[] = [];
  for (const seg of transcript.segments) {
    if (seg.end < scene.start || seg.start > scene.end) continue;
    const words = seg.words.filter((w) => w.end >= scene.start && w.start <= scene.end);
    const text = (words.length > 0 ? words.map((w) => w.word).join("") : seg.text).trim();
    if (text) parts.push(text);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 0 ? joined : null;
}
