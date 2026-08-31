import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { judgeTranscript } from "../claude/client.js";
import { logger } from "../utils/logger.js";
import type { WhisperTranscript } from "../types.js";

// Layer 4 is implemented in src/claude/client.ts (the API call lives with the
// SDK code). This module re-exports it and provides a CLI entry point so a
// transcript JSON file can be judged on its own:  pnpm judge <transcript.json>
export { judgeTranscript } from "../claude/client.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    logger.error("usage: tsx src/layers/layer4-judge.ts <transcript.json>");
    process.exit(1);
  }
  const transcript = JSON.parse(readFileSync(path, "utf8")) as WhisperTranscript;
  judgeTranscript(transcript)
    .then(({ clips }) => {
      process.stdout.write(JSON.stringify(clips, null, 2) + "\n");
    })
    .catch((err: unknown) => {
      logger.error("judge failed", { error: String(err) });
      process.exit(1);
    });
}
