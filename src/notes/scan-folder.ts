import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNote, InsufficientDiskError } from "./transcribe-note.js";
import { walkVideos } from "./transcribe-folder.js";
import { composeBrief } from "./clip-brief.js";
import { fileSizeGb } from "./disk.js";
import { judgeTranscript } from "../claude/client.js";
import { needsHumanReview, type ClipSpec } from "../config/schema.js";
import type { WhisperTranscript } from "../types.js";
import { logger } from "../utils/logger.js";

// Output collection folders (under the scanned root), excluded from the walk so
// we never try to "scan" our own output tree.
const SUMMARY_COLLECTION = "Summary Collections"; // scan-only notes (reused from note:folder)
const SHORTS_COLLECTION = "Viral Shorts"; // per-short briefs

// Machine state (resume markers + transcript cache) lives under the repo's
// outputs/, NOT on the footage drive — so F: only ever gets readable .md files.
const STATE_DIR = resolve(process.cwd(), "outputs", "scan-state");

// Best-effort shoot date: from a DJI-style filename, else the YYYY-MM-DD parent.
function shootDateFrom(videoPath: string): string | null {
  let m = basename(videoPath).match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = basename(dirname(videoPath)).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface TranscriptCache {
  hasSpeech: boolean;
  transcript: WhisperTranscript;
}

export interface ScanFolderOptions {
  only?: string;
  skip?: string; // exclude videos whose filename includes this (e.g. "DJI" for drone b-roll)
  limit?: number;
  overwrite?: boolean;
  minFreeGb?: number;
  maxFileGb?: number; // skip files larger than this (defer giants); 0/undef = no cap
}

function writeBriefs(
  videoPath: string,
  sourceRoot: string,
  shortsRoot: string,
  clips: ClipSpec[],
): string[] {
  if (clips.length === 0) return [];
  const stem = basename(videoPath, extname(videoPath));
  const dir = dirname(videoPath);
  const shootDate = shootDateFrom(videoPath);
  const collDir = join(shortsRoot, relative(sourceRoot, dir));
  mkdirSync(collDir, { recursive: true });

  const written: string[] = [];
  clips.forEach((clip, idx) => {
    const rank = idx + 1; // clips arrive sorted by virality_score desc
    const md = composeBrief(clip, rank, shootDate);
    const name = `${stem}--short-${String(rank).padStart(2, "0")}.md`;
    writeFileSync(join(dir, name), md, "utf8"); // beside the video
    writeFileSync(join(collDir, name), md, "utf8"); // mirrored for Obsidian
    written.push(name);
  });
  return written;
}

// Batch: for every video under a folder (recursively), produce BOTH
//   (1) a scan-only note  "<stem>.md"            — transcript + bilingual summary
//   (2) one brief per short "<stem>--short-NN.md" — Layer-4 viral clip specs
//
// ASR runs once per video and feeds both. Sequential, disk-safe, and resumable
// at two granularities:
//   - a video with a "<stem>.shorts.json" state marker is skipped entirely;
//   - if a video was transcribed but the *judge* step failed, the transcript is
//     cached so the retry skips the expensive ASR and only re-judges.
//
// Usage:
//   pnpm scan:folder "<folder>" [--only s] [--limit N] [--overwrite]
//             [--min-free-gb N] [--max-file-gb N]
export async function scanFolder(folder: string, opts: ScanFolderOptions = {}): Promise<void> {
  const summaryRoot = join(folder, SUMMARY_COLLECTION);
  const shortsRoot = join(folder, SHORTS_COLLECTION);
  const exclude = new Set([SUMMARY_COLLECTION, SHORTS_COLLECTION]);

  const all = walkVideos(folder, exclude)
    .filter((p) => (opts.only ? basename(p).includes(opts.only) : true))
    .filter((p) => (opts.skip ? !basename(p).includes(opts.skip) : true))
    .sort();

  // Per-video state file paths, mirrored under STATE_DIR by relative path.
  const stateBase = (p: string): string =>
    join(STATE_DIR, relative(folder, p)).replace(/\.[^.]+$/, "");
  const markerPath = (p: string): string => `${stateBase(p)}.shorts.json`;
  const cachePath = (p: string): string => `${stateBase(p)}.transcript.json`;

  const pending = all.filter((p) => opts.overwrite || !existsSync(markerPath(p)));
  const slice = opts.limit ? pending.slice(0, opts.limit) : pending;

  logger.info("scan:folder plan", {
    folder,
    videos: all.length,
    pending: pending.length,
    willProcess: slice.length,
    state_dir: STATE_DIR,
    shorts_collection: shortsRoot,
  });

  let done = 0;
  let failed = 0;
  let deferred = 0;
  let totalShorts = 0;
  let flagged = 0;
  for (const [i, path] of slice.entries()) {
    const f = basename(path);

    if (opts.maxFileGb && fileSizeGb(path) > opts.maxFileGb) {
      deferred++;
      logger.warn(`scan:folder [${i + 1}/${slice.length}] deferred (over --max-file-gb)`, {
        file: f,
        file_gb: Number(fileSizeGb(path).toFixed(1)),
      });
      continue;
    }

    logger.info(`scan:folder [${i + 1}/${slice.length}]`, { file: f });
    try {
      // 1) Transcript + scan-only note. Reuse a cached transcript (and the
      //    already-written .md) when a prior run transcribed but failed to judge.
      const cache = cachePath(path);
      let transcript: WhisperTranscript;
      let hasSpeech: boolean;
      if (!opts.overwrite && existsSync(cache)) {
        const cached = JSON.parse(readFileSync(cache, "utf8")) as TranscriptCache;
        transcript = cached.transcript;
        hasSpeech = cached.hasSpeech;
        logger.info("scan:folder reusing cached transcript (skip ASR)", { file: f });
      } else {
        const note = await buildNote(path, {
          diskSafe: true,
          minFreeGb: opts.minFreeGb,
          collectionRoot: summaryRoot,
          sourceRoot: folder,
        });
        transcript = note.transcript;
        hasSpeech = note.hasSpeech;
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ hasSpeech, transcript } satisfies TranscriptCache));
      }

      // 2) Judge → viral shorts. Skip the Claude call for speechless footage.
      //    A judge failure is isolated: the scan note is already written and the
      //    transcript is cached, so we surface the error and move on (the missing
      //    marker means the next run re-judges from cache, not from ASR).
      let clips: ClipSpec[] = [];
      if (hasSpeech) {
        transcript.source_file = f; // clean clip_id base; disk-safe temp is gone
        const shootDate = shootDateFrom(path);
        const { clips: judged } = await judgeTranscript(transcript, {
          title: basename(path, extname(path)),
          shoot_date: shootDate ?? undefined,
        });
        clips = judged;
      }

      // 3) One .md brief per short (beside the video + Viral Shorts mirror).
      const briefs = writeBriefs(path, folder, shortsRoot, clips);

      // 4) Success: write the marker/manifest and drop the transcript cache.
      mkdirSync(dirname(markerPath(path)), { recursive: true });
      writeFileSync(markerPath(path), JSON.stringify(clips, null, 2), "utf8");
      rmSync(cache, { force: true });

      totalShorts += clips.length;
      flagged += clips.filter(needsHumanReview).length;
      done++;
      logger.info("scan:folder item done", {
        file: f,
        has_speech: hasSpeech,
        shorts: clips.length,
        briefs: briefs.length,
      });
    } catch (err) {
      if (err instanceof InsufficientDiskError) {
        deferred++;
        logger.warn("scan:folder deferred (low disk)", { file: f, reason: err.message });
        continue;
      }
      failed++;
      logger.error("scan:folder item failed", { file: f, error: String(err) });
    }
  }

  logger.info("scan:folder complete", {
    done,
    failed,
    deferred,
    shorts: totalShorts,
    flagged_for_review: flagged,
    skipped_existing: all.length - slice.length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const folder = argv.find((a) => !a.startsWith("--"));
  if (!folder) {
    logger.error(
      'usage: pnpm scan:folder "<folder>" [--only s] [--skip s] [--limit N] [--overwrite] ' +
        "[--min-free-gb N] [--max-file-gb N]",
    );
    process.exit(1);
  }
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const num = (flag: string): number | undefined => {
    const v = val(flag);
    return v !== undefined ? Number(v) : undefined;
  };
  scanFolder(folder, {
    only: val("--only"),
    skip: val("--skip"),
    limit: num("--limit"),
    overwrite: argv.includes("--overwrite"),
    minFreeGb: num("--min-free-gb"),
    maxFileGb: num("--max-file-gb"),
  }).catch((err: unknown) => {
    logger.error("scan:folder failed", { error: String(err) });
    process.exit(1);
  });
}
