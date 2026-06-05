import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { asrEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { WhisperTranscript } from "../types.js";

// Layer 3 — run faster-whisper (Python) as a subprocess and parse its JSON
// transcript with word-level timestamps. The Python side does all the ASR;
// this is just an orchestration boundary.
export function transcribe(videoPath: string): Promise<WhisperTranscript> {
  const { python, whisperModel } = asrEnv();
  const script = resolve(process.cwd(), "python/asr.py");
  const args = [script, "--model", whisperModel, "--input", videoPath];

  logger.info("layer3 transcribing", { video: basename(videoPath), whisperModel });

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(python, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to launch ASR (${python}): ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ASR exited with code ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as WhisperTranscript);
      } catch (err) {
        reject(new Error(`Could not parse ASR output as JSON: ${String(err)}`));
      }
    });
  });
}

// Allow `pnpm asr <video>` for quick standalone transcription.
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  if (!input) {
    logger.error("usage: tsx src/layers/layer3-asr.ts <video-file>");
    process.exit(1);
  }
  transcribe(input)
    .then((t) => {
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    })
    .catch((err: unknown) => {
      logger.error("asr failed", { error: String(err) });
      process.exit(1);
    });
}
