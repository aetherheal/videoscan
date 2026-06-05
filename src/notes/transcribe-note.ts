import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { transcribe } from "../layers/layer3-asr.js";
import { probeDuration } from "../index/scene-detect.js";
import { fullTranscriptText } from "../index/transcript.js";
import { summarizeTranscript } from "./summarize.js";
import { extractAudio } from "./audio.js";
import { fileSizeGb, freeGbLocal } from "./disk.js";
import { logger } from "../utils/logger.js";

export interface NoteOptions {
  // Disk-safe: gate on free space, transcribe from a small extracted-audio temp,
  // then delete the temp. On by default — the whole point for big Drive batches.
  diskSafe?: boolean;
  minFreeGb?: number; // headroom to keep free after a file downloads (default 5)
}

export interface NoteResult {
  txtPath: string;
  hasSpeech: boolean;
  chars: number;
  durationSec: number;
}

export class InsufficientDiskError extends Error {}

// Try to read a YYYYMMDD shoot date out of DJI-style filenames; null otherwise.
function shootDateFrom(name: string): string | null {
  const m = name.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function composeNote(
  filename: string,
  durationSec: number,
  language: string,
  summary: string,
  englishTranscript: string,
  originalTranscript: string,
): string {
  const date = shootDateFrom(filename);
  const mins = Math.floor(durationSec / 60);
  const secs = Math.round(durationSec % 60);
  const header = [
    filename,
    [
      date ? `Shoot date: ${date}` : null,
      `Length: ${mins}m ${secs}s`,
      `Source language: ${language}`,
    ]
      .filter(Boolean)
      .join("  |  "),
  ].join("\n");

  const hasSpeech = originalTranscript.trim().length > 0;
  const sep = "=".repeat(60);

  return (
    `${header}\n${sep}\n\n` +
    `[SUMMARY]\n${summary}\n\n` +
    `${sep}\n[TRANSCRIPT — ENGLISH]\n` +
    `${hasSpeech ? englishTranscript.trim() : "(no speech)"}\n\n` +
    `${sep}\n[TRANSCRIPT — ORIGINAL (${language})]\n` +
    `${hasSpeech ? originalTranscript.trim() : "(no speech)"}\n`
  );
}

// Transcribe + summarize one video; write "<name>.txt" next to the source.
export async function buildNote(
  videoPath: string,
  opts: NoteOptions = {},
): Promise<NoteResult> {
  const diskSafe = opts.diskSafe ?? true;
  const minFreeGb = opts.minFreeGb ?? 5;
  const filename = basename(videoPath);
  const duration = probeDuration(videoPath);

  // Reading the source downloads it into Drive's local cache, so require room
  // for the file plus a safety margin before we touch it.
  if (diskSafe) {
    const free = freeGbLocal();
    const size = fileSizeGb(videoPath);
    if (free - size < minFreeGb) {
      throw new InsufficientDiskError(
        `skipping ${filename}: free ${free.toFixed(1)}GB, file ${size.toFixed(1)}GB, ` +
          `need ${(size + minFreeGb).toFixed(1)}GB free`,
      );
    }
    logger.info("note: disk check ok", {
      file: filename,
      free_gb: Number(free.toFixed(1)),
      file_gb: Number(size.toFixed(1)),
    });
  }

  logger.info("note: transcribing", { file: filename, disk_safe: diskSafe });

  let transcript;
  if (diskSafe) {
    const scratch = resolve(process.cwd(), "outputs/.scratch");
    const wav = extractAudio(videoPath, scratch);
    try {
      transcript = await transcribe(wav);
    } finally {
      rmSync(wav, { force: true }); // never leave the large-ish temp behind
    }
  } else {
    transcript = await transcribe(videoPath);
  }

  const text = fullTranscriptText(transcript);
  const { summary, englishTranscript } = await summarizeTranscript(
    { filename, durationSec: duration, language: transcript.language },
    text,
  );

  const note = composeNote(
    filename,
    duration,
    transcript.language,
    summary,
    englishTranscript,
    text,
  );
  const txtPath = join(dirname(videoPath), `${basename(videoPath, extname(videoPath))}.txt`);
  writeFileSync(txtPath, note, "utf8");

  logger.info("note: written", { txtPath, has_speech: text.length > 0 });
  return { txtPath, hasSpeech: text.length > 0, chars: text.length, durationSec: duration };
}

// CLI: pnpm note <video-file> [--no-disk-safe] [--min-free-gb N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const video = argv.find((a) => !a.startsWith("--"));
  if (!video) {
    logger.error("usage: pnpm note <video-file> [--no-disk-safe] [--min-free-gb N]");
    process.exit(1);
  }
  const minIdx = argv.indexOf("--min-free-gb");
  buildNote(video, {
    diskSafe: !argv.includes("--no-disk-safe"),
    minFreeGb: minIdx !== -1 ? Number(argv[minIdx + 1]) : undefined,
  })
    .then((r) => process.stdout.write(`\nwrote ${r.txtPath}\n`))
    .catch((err: unknown) => {
      logger.error("note failed", { error: String(err) });
      process.exit(1);
    });
}
