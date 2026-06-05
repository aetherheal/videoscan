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

interface ComposeFields {
  filename: string;
  durationSec: number;
  language: string;
  summaryEn: string;
  summaryKo: string;
  transcriptEn: string;
  transcriptKo: string;
  hasSpeech: boolean;
}

function composeNote(f: ComposeFields): string {
  const date = shootDateFrom(f.filename);
  const mins = Math.floor(f.durationSec / 60);
  const secs = Math.round(f.durationSec % 60);
  const header = [
    f.filename,
    [
      date ? `Shoot date: ${date}` : null,
      `Length: ${mins}m ${secs}s`,
      `Source language: ${f.language}`,
    ]
      .filter(Boolean)
      .join("  |  "),
  ].join("\n");

  const sep = "=".repeat(60);
  const en = f.hasSpeech ? f.transcriptEn.trim() : "(no speech)";
  const ko = f.hasSpeech ? f.transcriptKo.trim() : "(음성 없음)";

  return (
    `${header}\n${sep}\n\n` +
    `[SUMMARY — EN]\n${f.summaryEn}\n\n` +
    `[SUMMARY — 한국어]\n${f.summaryKo}\n\n` +
    `${sep}\n[TRANSCRIPT — ENGLISH]\n${en}\n\n` +
    `${sep}\n[TRANSCRIPT — 한국어]\n${ko}\n`
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
  const lang = transcript.language;
  const c = await summarizeTranscript({ filename, durationSec: duration, language: lang }, text);

  // Pin the source-language transcript to the verbatim ASR text (ground truth);
  // the other language stays the model translation.
  const transcriptEn = lang.startsWith("en") && text ? text : c.transcriptEn;
  const transcriptKo = lang.startsWith("ko") && text ? text : c.transcriptKo;

  const note = composeNote({
    filename,
    durationSec: duration,
    language: lang,
    summaryEn: c.summaryEn,
    summaryKo: c.summaryKo,
    transcriptEn,
    transcriptKo,
    hasSpeech: text.length > 0,
  });
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
