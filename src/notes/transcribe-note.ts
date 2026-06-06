import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  // Optional second output location. When both are set, the .md note is also
  // written under collectionRoot, mirroring the video's path relative to
  // sourceRoot (e.g. F:\...\Summary Collections\2026-03-11\clip.md).
  collectionRoot?: string;
  sourceRoot?: string;
}

export interface NoteResult {
  notePath: string;
  collectionPath?: string;
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

// Fall back to a YYYY-MM-DD date encoded in the parent folder name.
function shootDateFromDir(videoPath: string): string | null {
  const parent = basename(dirname(videoPath));
  const m = parent.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Pull the "Topic tags: a, b, c" line out of the EN summary into Obsidian tags.
function topicTags(summaryEn: string): string[] {
  const m = summaryEn.match(/Topic tags:\s*(.+)/i);
  if (!m) return [];
  return (m[1] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && t.toLowerCase() !== "none")
    .map((t) => t.replace(/\s+/g, "-"))
    .slice(0, 12);
}

// Minimal YAML-safe double-quoted scalar (also normalizes Windows backslashes).
function yamlStr(s: string): string {
  return '"' + s.replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
}

interface ComposeFields {
  filename: string;
  sourcePath: string;
  durationSec: number;
  language: string;
  shootDate: string | null;
  summaryEn: string;
  summaryKo: string;
  transcriptEn: string;
  transcriptKo: string;
  hasSpeech: boolean;
}

// Render an Obsidian-friendly Markdown note: YAML frontmatter + bilingual body.
function composeNote(f: ComposeFields): string {
  const mins = Math.floor(f.durationSec / 60);
  const secs = Math.round(f.durationSec % 60);
  const length = `${mins}m ${secs}s`;
  const stem = f.filename.replace(/\.[^.]+$/, "");
  const tags = ["튠의원", "recording", ...topicTags(f.summaryEn)];

  const frontmatter = [
    "---",
    `title: ${yamlStr(stem)}`,
    `source_file: ${yamlStr(f.sourcePath)}`,
    f.shootDate ? `shoot_date: ${f.shootDate}` : null,
    `length: ${yamlStr(length)}`,
    `duration_sec: ${Math.round(f.durationSec)}`,
    `language: ${f.language}`,
    `has_speech: ${f.hasSpeech}`,
    `tags: [${tags.map(yamlStr).join(", ")}]`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const meta = [
    f.shootDate ? `Shoot date: ${f.shootDate}` : null,
    `Length: ${length}`,
    `Source language: ${f.language}`,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const en = f.hasSpeech ? f.transcriptEn.trim() : "(no speech)";
  const ko = f.hasSpeech ? f.transcriptKo.trim() : "(음성 없음)";

  return (
    `${frontmatter}\n\n` +
    `# ${stem}\n\n> ${meta}\n\n` +
    `## 📌 Summary (EN)\n\n${f.summaryEn}\n\n` +
    `## 📌 요약 (한국어)\n\n${f.summaryKo}\n\n` +
    `## 📝 Transcript (English)\n\n${en}\n\n` +
    `## 📝 전사 (한국어)\n\n${ko}\n`
  );
}

// Transcribe + summarize one video; write "<name>.md" next to the source (and,
// if a collection root is given, a mirrored copy under it).
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
    sourcePath: videoPath,
    durationSec: duration,
    language: lang,
    shootDate: shootDateFrom(filename) ?? shootDateFromDir(videoPath),
    summaryEn: c.summaryEn,
    summaryKo: c.summaryKo,
    transcriptEn,
    transcriptKo,
    hasSpeech: text.length > 0,
  });

  const stem = basename(videoPath, extname(videoPath));
  const notePath = join(dirname(videoPath), `${stem}.md`);
  writeFileSync(notePath, note, "utf8");

  // Optional mirrored copy in the collection folder, preserving subfolders.
  let collectionPath: string | undefined;
  if (opts.collectionRoot && opts.sourceRoot) {
    const relDir = relative(opts.sourceRoot, dirname(videoPath));
    const collDir = join(opts.collectionRoot, relDir);
    mkdirSync(collDir, { recursive: true });
    collectionPath = join(collDir, `${stem}.md`);
    writeFileSync(collectionPath, note, "utf8");
  }

  logger.info("note: written", { notePath, collectionPath, has_speech: text.length > 0 });
  return {
    notePath,
    collectionPath,
    hasSpeech: text.length > 0,
    chars: text.length,
    durationSec: duration,
  };
}

// CLI: pnpm note <video-file> [--no-disk-safe] [--min-free-gb N]
//                            [--collection <dir>] [--source-root <dir>]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const video = argv.find((a) => !a.startsWith("--"));
  if (!video) {
    logger.error("usage: pnpm note <video-file> [--no-disk-safe] [--min-free-gb N]");
    process.exit(1);
  }
  const flagVal = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const minIdx = argv.indexOf("--min-free-gb");
  buildNote(video, {
    diskSafe: !argv.includes("--no-disk-safe"),
    minFreeGb: minIdx !== -1 ? Number(argv[minIdx + 1]) : undefined,
    collectionRoot: flagVal("--collection"),
    sourceRoot: flagVal("--source-root"),
  })
    .then((r) => {
      process.stdout.write(`\nwrote ${r.notePath}\n`);
      if (r.collectionPath) process.stdout.write(`wrote ${r.collectionPath}\n`);
    })
    .catch((err: unknown) => {
      logger.error("note failed", { error: String(err) });
      process.exit(1);
    });
}
