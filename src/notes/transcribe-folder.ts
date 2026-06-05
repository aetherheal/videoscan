import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { buildNote, InsufficientDiskError } from "./transcribe-note.js";
import { fileSizeGb } from "./disk.js";
import { logger } from "../utils/logger.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv"]);

export interface FolderOptions {
  only?: string;
  limit?: number;
  overwrite?: boolean;
  diskSafe?: boolean; // default true
  minFreeGb?: number; // default 5
  maxFileGb?: number; // skip files larger than this (defer giants); 0/undef = no cap
}

// Batch: transcribe + summarize every video in a folder, writing "<name>.txt"
// beside each. Sequential (ASR is CPU-bound, Drive downloads are large) and
// resumable (already-noted files are skipped). Disk-safe by default: each file
// is gated on free space and transcribed from a small extracted-audio temp, so
// a huge Drive folder won't fill the startup disk.
//
// Usage:
//   pnpm note:folder "<folder>" [--only s] [--limit N] [--overwrite]
//                               [--no-disk-safe] [--min-free-gb N] [--max-file-gb N]
export async function transcribeFolder(folder: string, opts: FolderOptions = {}): Promise<void> {
  const diskSafe = opts.diskSafe ?? true;

  const all = readdirSync(folder)
    .filter((f) => VIDEO_EXTS.has(extname(f).toLowerCase()))
    .filter((f) => (opts.only ? f.includes(opts.only) : true))
    .sort();

  const pending = all.filter((f) => {
    const txt = join(folder, f.replace(/\.[^.]+$/, ".txt"));
    return opts.overwrite || !existsSync(txt);
  });

  const slice = opts.limit ? pending.slice(0, opts.limit) : pending;
  logger.info("note:folder plan", {
    folder,
    videos: all.length,
    pending: pending.length,
    willProcess: slice.length,
    disk_safe: diskSafe,
    max_file_gb: opts.maxFileGb ?? null,
  });

  let done = 0;
  let failed = 0;
  let deferred = 0; // skipped this run for size/space — try again later, not an error
  for (const [i, f] of slice.entries()) {
    const path = join(folder, f);

    if (opts.maxFileGb && fileSizeGb(path) > opts.maxFileGb) {
      deferred++;
      logger.warn(`note:folder [${i + 1}/${slice.length}] deferred (over --max-file-gb)`, {
        file: f,
        file_gb: Number(fileSizeGb(path).toFixed(1)),
        max_file_gb: opts.maxFileGb,
      });
      continue;
    }

    logger.info(`note:folder [${i + 1}/${slice.length}]`, { file: f });
    try {
      await buildNote(path, { diskSafe, minFreeGb: opts.minFreeGb });
      done++;
    } catch (err) {
      if (err instanceof InsufficientDiskError) {
        deferred++;
        logger.warn("note:folder deferred (low disk)", { file: f, reason: err.message });
        continue;
      }
      failed++;
      logger.error("note:folder item failed", { file: f, error: String(err) });
    }
  }
  logger.info("note:folder complete", {
    done,
    failed,
    deferred,
    skipped_existing: all.length - slice.length,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const folder = argv.find((a) => !a.startsWith("--"));
  if (!folder) {
    logger.error(
      'usage: pnpm note:folder "<folder>" [--only s] [--limit N] [--overwrite] ' +
        "[--no-disk-safe] [--min-free-gb N] [--max-file-gb N]",
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
  transcribeFolder(folder, {
    only: val("--only"),
    limit: num("--limit"),
    overwrite: argv.includes("--overwrite"),
    diskSafe: !argv.includes("--no-disk-safe"),
    minFreeGb: num("--min-free-gb"),
    maxFileGb: num("--max-file-gb"),
  }).catch((err: unknown) => {
    logger.error("note:folder failed", { error: String(err) });
    process.exit(1);
  });
}
