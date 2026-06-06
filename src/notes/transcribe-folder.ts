import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNote, InsufficientDiskError } from "./transcribe-note.js";
import { fileSizeGb } from "./disk.js";
import { logger } from "../utils/logger.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv"]);

// Default sub-folder (under the scanned root) where mirrored .md notes collect.
// Excluded from the scan so we never try to "transcribe" our own output tree.
const COLLECTION_DIRNAME = "Summary Collections";

export interface FolderOptions {
  only?: string;
  limit?: number;
  overwrite?: boolean;
  diskSafe?: boolean; // default true
  minFreeGb?: number; // default 5
  maxFileGb?: number; // skip files larger than this (defer giants); 0/undef = no cap
  collectionDir?: string; // default <folder>/Summary Collections; "" disables
}

// Recursively list video files under root, skipping excluded directory names.
function walkVideos(root: string, excludeDirs: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      out.push(...walkVideos(full, excludeDirs));
    } else if (VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// Batch: transcribe + summarize every video under a folder (recursively),
// writing "<name>.md" beside each and a mirrored copy under the collection
// folder. Sequential (ASR is CPU-bound, Drive downloads are large) and
// resumable (videos that already have a .md beside them are skipped).
// Disk-safe by default: each file is gated on free space and transcribed from a
// small extracted-audio temp, so a huge Drive folder won't fill the startup disk.
//
// Usage:
//   pnpm note:folder "<folder>" [--only s] [--limit N] [--overwrite]
//             [--no-disk-safe] [--min-free-gb N] [--max-file-gb N] [--collection <dir>]
export async function transcribeFolder(folder: string, opts: FolderOptions = {}): Promise<void> {
  const diskSafe = opts.diskSafe ?? true;
  const collectionRoot =
    opts.collectionDir === "" ? undefined : (opts.collectionDir ?? join(folder, COLLECTION_DIRNAME));

  const excludeDirs = new Set<string>([COLLECTION_DIRNAME]);
  if (collectionRoot) excludeDirs.add(basename(collectionRoot));

  const all = walkVideos(folder, excludeDirs)
    .filter((p) => (opts.only ? basename(p).includes(opts.only) : true))
    .sort();

  const pending = all.filter((p) => {
    const md = p.replace(/\.[^.]+$/, ".md");
    return opts.overwrite || !existsSync(md);
  });

  const slice = opts.limit ? pending.slice(0, opts.limit) : pending;
  logger.info("note:folder plan", {
    folder,
    videos: all.length,
    pending: pending.length,
    willProcess: slice.length,
    disk_safe: diskSafe,
    collection: collectionRoot ?? null,
    max_file_gb: opts.maxFileGb ?? null,
  });

  let done = 0;
  let failed = 0;
  let deferred = 0; // skipped this run for size/space — try again later, not an error
  for (const [i, path] of slice.entries()) {
    const f = basename(path);

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
      await buildNote(path, {
        diskSafe,
        minFreeGb: opts.minFreeGb,
        collectionRoot,
        sourceRoot: folder,
      });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const folder = argv.find((a) => !a.startsWith("--"));
  if (!folder) {
    logger.error(
      'usage: pnpm note:folder "<folder>" [--only s] [--limit N] [--overwrite] ' +
        "[--no-disk-safe] [--min-free-gb N] [--max-file-gb N] [--collection <dir>]",
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
    collectionDir: val("--collection"),
  }).catch((err: unknown) => {
    logger.error("note:folder failed", { error: String(err) });
    process.exit(1);
  });
}
