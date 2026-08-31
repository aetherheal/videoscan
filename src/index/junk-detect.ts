import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { footageIndexSchema, type FootageIndex } from "../config/schema.js";
import { walkVideos } from "../notes/transcribe-folder.js";
import { logger } from "../utils/logger.js";
import { probeDuration } from "./scene-detect.js";

const MIB = 1024 * 1024;

// Accidental camera taps are normally over almost immediately. Duration is the
// strongest cheap signal, so it gets most of the score while 6-10 second clips
// receive only enough weight to require corroborating evidence.
const VERY_SHORT_SECONDS = 1;
const SHORT_SECONDS = 3;
const BRIEF_SECONDS = 6;
const POSSIBLY_ACCIDENTAL_SECONDS = 10;
// A fumbled start/stop can easily run 10-30s. 313 of the library's 697 clips are
// 60s+, so a band this wide does not flood the review queue — but on its own it
// is weak evidence, hence the low weight.
const MAYBE_ACCIDENTAL_SECONDS = 30;

// Absolute size is weak evidence: bitrates across this library vary enormously.
// These thresholds only corroborate other signals.
const TINY_FILE_BYTES = 5 * MIB;
const SMALL_FILE_BYTES = 15 * MIB;

// MEASURED over this library (sample of the shortest DJI Pocket clips):
// bitrates run 22-40 Mbps, so a legitimate 10s clip is already ~45 MiB and a
// legitimate 14s clip ~40-65 MiB. Anything keyed on "short but large" must sit
// well above that or it flags every ordinary short cutaway. 120 MiB inside 30s
// implies >33 Mbps sustained, i.e. genuinely disproportionate.
//
// Note on the 89.7 MB clip cited in docs/plan-footage-ops.md: at this library's
// real bitrates that is a ~25-30s clip, not a "short but large" one. It is
// covered by the MAYBE_ACCIDENTAL_SECONDS duration band, and — honestly —
// cheap signals alone cannot confidently condemn a 25s clip. It needs a
// footage index to be called with confidence, which is what the index signals
// below are for.
const LARGE_FOR_SHORT_BYTES = 120 * MIB;

// Average bitrate catches files whose size and duration are out of proportion.
// Below 0.25 Mbps is implausibly sparse for ordinary camera footage. The upper
// gate is set comfortably above the 38 Mbps maximum measured across this
// library, so legitimate footage is never penalized; the original 350 was above
// anything this hardware can produce and never fired at all.
const MIN_BITRATE_SAMPLE_SECONDS = 5;
const VERY_LOW_BITRATE_MBPS = 0.25;
const VERY_HIGH_BITRATE_MBPS = 70;

// Six words or fewer is treated as a near-empty catalog description. It matters
// only when every scene is also marked B-roll, so well-described B-roll is not
// penalized merely for being B-roll.
const NEAR_EMPTY_DESCRIPTION_WORDS = 6;

// 40 requires one strong signal or several weak ones. Callers can widen or
// narrow the human-review queue with --min-score; scores are capped at 100.
const DEFAULT_MIN_SCORE = 40;

// Duration alone must not push a clip over DEFAULT_MIN_SCORE: a deliberate 3s
// cutaway is legitimate footage. Anything above the "camera tap" band therefore
// needs a second, independent signal to reach the review queue. The <=1s band is
// exempt because a sub-second clip is decisive on its own.
const DURATION_ONLY_CAP = DEFAULT_MIN_SCORE - 5;

const OUTTAKE_HINTS = [
  "accidental",
  "outtake",
  "camera setup",
  "setup moment",
  "camera handling",
  "handling moment",
  "behind the scenes filler",
  "transition frame",
  "blurry",
] as const;

type IndexStatus = "loaded" | "not_found" | "invalid" | "source_mismatch";

interface IndexLookup {
  status: IndexStatus;
  path: string;
  index?: FootageIndex;
  detail?: string;
}

export interface JunkCandidate {
  rank: number;
  path: string;
  relative_path: string;
  size_bytes: number;
  duration_seconds: number;
  average_bitrate_mbps: number;
  score: number;
  reason: string;
  index_status: IndexStatus;
  index_path: string;
}

export interface JunkScanFailure {
  path: string;
  relative_path: string;
  error: string;
}

export interface JunkScanReport {
  generated_at: string;
  root: string;
  warning: string;
  filters: {
    min_score: number;
    limit: number | null;
  };
  scan: {
    videos_found: number;
    videos_scored: number;
    valid_indexes_used: number;
    cheap_signals_only: number;
    failed: number;
  };
  candidates_found: number;
  candidates_reported: number;
  reclaimable_bytes: number;
  reclaimable_bytes_before_limit: number;
  candidates: JunkCandidate[];
  failures: JunkScanFailure[];
}

export interface JunkScanOptions {
  minScore?: number;
  limit?: number;
  outputsRoot?: string;
}

interface ScoredClip extends Omit<JunkCandidate, "rank"> {}

function rounded(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchingOuttakeLabels(values: string[]): string[] {
  return [...new Set(values.filter((value) => {
    const normalized = normalizeLabel(value);
    return OUTTAKE_HINTS.some((hint) => normalized.includes(hint));
  }))];
}

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function lookupIndex(videoPath: string, outputsRoot: string): IndexLookup {
  const stem = basename(videoPath, extname(videoPath));
  const indexPath = join(outputsRoot, stem, "footage-index.json");
  if (!existsSync(indexPath)) return { status: "not_found", path: indexPath };

  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
    const validated = footageIndexSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        status: "invalid",
        path: indexPath,
        detail: validated.error.issues[0]?.message ?? "schema validation failed",
      };
    }

    if (validated.data.source_file.toLowerCase() !== basename(videoPath).toLowerCase()) {
      return {
        status: "source_mismatch",
        path: indexPath,
        detail: `index source_file is ${validated.data.source_file}`,
      };
    }

    return { status: "loaded", path: indexPath, index: validated.data };
  } catch (err) {
    return { status: "invalid", path: indexPath, detail: String(err) };
  }
}

function scoreClip(
  videoPath: string,
  sourceRoot: string,
  sizeBytes: number,
  duration: number,
  indexLookup: IndexLookup,
): ScoredClip {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(`+${points}: ${reason}`);
  };

  // Duration and raw file size are not independent: a short clip is small
  // *because* it is short, so the two together are still only one piece of
  // evidence. Track genuinely independent signals — an existing catalog verdict,
  // a bitrate anomaly, or the short-and-large combination — separately, so a
  // clip supported by nothing else can be capped below the review threshold.
  let independentEvidence = 0;
  const addIndependent = (points: number, reason: string) => {
    independentEvidence += points;
    add(points, reason);
  };

  if (duration <= VERY_SHORT_SECONDS) {
    // Decisive on its own; deliberately not counted toward the cap.
    add(60, `duration is only ${duration.toFixed(2)}s (typical accidental camera tap)`);
  } else if (duration <= SHORT_SECONDS) {
    add(45, `duration is only ${duration.toFixed(2)}s`);
  } else if (duration <= BRIEF_SECONDS) {
    add(25, `duration is only ${duration.toFixed(2)}s`);
  } else if (duration <= POSSIBLY_ACCIDENTAL_SECONDS) {
    add(10, `duration is only ${duration.toFixed(2)}s`);
  } else if (duration <= MAYBE_ACCIDENTAL_SECONDS) {
    add(6, `duration is only ${duration.toFixed(2)}s`);
  }

  if (sizeBytes <= TINY_FILE_BYTES) {
    add(12, `file is only ${formatBytes(sizeBytes)}`);
  } else if (sizeBytes <= SMALL_FILE_BYTES) {
    add(8, `file is only ${formatBytes(sizeBytes)}`);
  }

  // Short *and* large: an accidental 4K recording is too big to look small and
  // too long to look like a tap, so neither threshold above catches it. This is
  // the 89.7 MB case from docs/plan-footage-ops.md.
  if (duration <= MAYBE_ACCIDENTAL_SECONDS && sizeBytes >= LARGE_FOR_SHORT_BYTES) {
    addIndependent(
      22,
      `only ${duration.toFixed(2)}s but ${formatBytes(sizeBytes)} — large for such a short clip`,
    );
  }

  const averageBitrateMbps = (sizeBytes * 8) / duration / 1_000_000;
  if (duration >= MIN_BITRATE_SAMPLE_SECONDS && averageBitrateMbps < VERY_LOW_BITRATE_MBPS) {
    addIndependent(10, `average bitrate is unusually low (${averageBitrateMbps.toFixed(2)} Mbps)`);
  } else if (averageBitrateMbps > VERY_HIGH_BITRATE_MBPS) {
    addIndependent(
      8,
      `size is unusually large for its duration (${averageBitrateMbps.toFixed(1)} Mbps)`,
    );
  }

  const index = indexLookup.index;
  if (index) {
    if (index.content_type === "other") {
      addIndependent(12, 'existing catalog classified content_type as "other"');
    }

    const labels = index.scenes.flatMap((scene) => [...scene.tags, ...scene.usable_for]);
    const matchedLabels = matchingOuttakeLabels(labels);
    if (matchedLabels.length > 0) {
      const points = 18 + Math.min((matchedLabels.length - 1) * 3, 7);
      addIndependent(points, `catalog labels look outtake-like (${matchedLabels.slice(0, 4).join(", ")})`);
    }

    const summaryMatches = matchingOuttakeLabels([index.summary]);
    if (summaryMatches.length > 0) {
      addIndependent(10, `catalog summary looks outtake-like (${summaryMatches[0]})`);
    }

    const everySceneIsThinBroll = index.scenes.length > 0
      && index.scenes.every((scene) => scene.is_b_roll)
      && index.scenes.every(
        (scene) => wordCount(scene.description) <= NEAR_EMPTY_DESCRIPTION_WORDS,
      );
    if (everySceneIsThinBroll) {
      addIndependent(10, "every scene is B-roll with a near-empty description");
    }
  } else {
    const detail = indexLookup.detail ? ` (${indexLookup.detail})` : "";
    reasons.push(
      `No usable existing footage index${detail}; score uses duration and file size only.`,
    );
  }

  if (reasons.length === 0) reasons.push("No junk signals met the scoring thresholds.");

  // A clip whose *only* evidence is "it's short" must not reach the review queue
  // on that alone — a deliberate 3-second cutaway is legitimate footage. Once any
  // other signal corroborates, the full score stands.
  let finalScore = score;
  const isDecisivelyShort = duration <= VERY_SHORT_SECONDS;
  if (!isDecisivelyShort && independentEvidence === 0 && score > DURATION_ONLY_CAP) {
    finalScore = DURATION_ONLY_CAP;
    reasons.push(
      `Capped at ${DURATION_ONLY_CAP}: duration and file size are the only signals, `
        + "and those are not independent of each other. Needs corroboration "
        + "(a footage index, a bitrate anomaly, or short-but-large) to reach the review queue.",
    );
  }

  return {
    path: resolve(videoPath),
    relative_path: relative(sourceRoot, videoPath),
    size_bytes: sizeBytes,
    duration_seconds: rounded(duration, 3),
    average_bitrate_mbps: rounded(averageBitrateMbps, 3),
    score: Math.min(finalScore, 100),
    reason: reasons.join(" "),
    index_status: indexLookup.status,
    index_path: indexLookup.path,
  };
}

function validateOptions(opts: JunkScanOptions): void {
  if (opts.minScore !== undefined
      && (!Number.isFinite(opts.minScore) || opts.minScore < 0 || opts.minScore > 100)) {
    throw new Error("minScore must be a number from 0 to 100");
  }
  if (opts.limit !== undefined
      && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new Error("limit must be a positive integer");
  }
}

export function scanJunkCandidates(
  root: string,
  opts: JunkScanOptions = {},
): JunkScanReport {
  validateOptions(opts);
  const sourceRoot = resolve(root);
  const rootStat = statSync(sourceRoot);
  if (!rootStat.isDirectory()) throw new Error(`--root is not a directory: ${sourceRoot}`);

  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const outputsRoot = resolve(opts.outputsRoot ?? join(process.cwd(), "outputs"));
  const videos = walkVideos(sourceRoot, new Set())
    .filter((videoPath) => !basename(videoPath).startsWith("._"))
    .sort();

  logger.info("junk:scan plan", {
    root: sourceRoot,
    videos: videos.length,
    min_score: minScore,
    limit: opts.limit ?? null,
    outputs_root: outputsRoot,
  });

  const scored: ScoredClip[] = [];
  const failures: JunkScanFailure[] = [];
  let validIndexesUsed = 0;
  let cheapSignalsOnly = 0;

  for (const [i, videoPath] of videos.entries()) {
    const file = basename(videoPath);
    logger.info(`junk:scan [${i + 1}/${videos.length}]`, { file });
    try {
      const sizeBytes = statSync(videoPath).size;
      const duration = probeDuration(videoPath);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("ffprobe could not read a positive duration");
      }

      const indexLookup = lookupIndex(videoPath, outputsRoot);
      if (indexLookup.status === "loaded") {
        validIndexesUsed++;
      } else {
        cheapSignalsOnly++;
        if (indexLookup.status !== "not_found") {
          logger.warn("junk:scan existing index ignored", {
            file,
            status: indexLookup.status,
            detail: indexLookup.detail,
          });
        }
      }

      scored.push(scoreClip(videoPath, sourceRoot, sizeBytes, duration, indexLookup));
    } catch (err) {
      const failure = {
        path: resolve(videoPath),
        relative_path: relative(sourceRoot, videoPath),
        error: String(err),
      };
      failures.push(failure);
      logger.error("junk:scan item failed", { file, error: failure.error });
    }
  }

  const qualifying = scored
    .filter((clip) => clip.score >= minScore)
    .sort((a, b) => b.score - a.score
      || a.duration_seconds - b.duration_seconds
      || a.size_bytes - b.size_bytes
      || a.relative_path.localeCompare(b.relative_path));
  const selected = opts.limit === undefined ? qualifying : qualifying.slice(0, opts.limit);
  const candidates = selected.map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    generated_at: new Date().toISOString(),
    root: sourceRoot,
    warning: "Deletion candidates only. No files were deleted, moved, or modified.",
    filters: { min_score: minScore, limit: opts.limit ?? null },
    scan: {
      videos_found: videos.length,
      videos_scored: scored.length,
      valid_indexes_used: validIndexesUsed,
      cheap_signals_only: cheapSignalsOnly,
      failed: failures.length,
    },
    candidates_found: qualifying.length,
    candidates_reported: candidates.length,
    reclaimable_bytes: candidates.reduce((total, clip) => total + clip.size_bytes, 0),
    reclaimable_bytes_before_limit: qualifying.reduce(
      (total, clip) => total + clip.size_bytes,
      0,
    ),
    candidates,
    failures,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MIB) return `${(bytes / (1024 * MIB)).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function printSummary(report: JunkScanReport, outPath: string): void {
  process.stdout.write("\nJunk/deletion candidates (human review only; nothing was deleted)\n\n");
  process.stdout.write(
    `${"SCORE".padEnd(7)}${"DURATION".padEnd(12)}${"SIZE".padEnd(13)}`
      + `${"INDEX".padEnd(17)}PATH\n`,
  );
  process.stdout.write(`${"-".repeat(74)}\n`);

  if (report.candidates.length === 0) {
    process.stdout.write("No clips met the configured minimum score.\n");
  } else {
    for (const candidate of report.candidates) {
      process.stdout.write(
        `${String(candidate.score).padEnd(7)}`
          + `${`${candidate.duration_seconds.toFixed(2)}s`.padEnd(12)}`
          + `${formatBytes(candidate.size_bytes).padEnd(13)}`
          + `${candidate.index_status.padEnd(17)}`
          + `${candidate.relative_path}\n`,
      );
      process.stdout.write(`       ${candidate.reason}\n`);
    }
  }

  process.stdout.write(
    `\nReported ${report.candidates_reported} of ${report.candidates_found} candidate(s); `
      + `potential reclaim ${formatBytes(report.reclaimable_bytes)}.\n`,
  );
  if (report.filters.limit !== null && report.candidates_found > report.candidates_reported) {
    process.stdout.write(
      `All candidates before --limit represent ${formatBytes(report.reclaimable_bytes_before_limit)}.\n`,
    );
  }
  process.stdout.write(
    `Scored ${report.scan.videos_scored}/${report.scan.videos_found} video(s); `
      + `${report.scan.cheap_signals_only} used cheap signals only; `
      + `${report.scan.failed} failed.\nJSON report: ${outPath}\n`,
  );
}

interface CliOptions {
  root: string;
  out: string;
  outputsRoot?: string;
  minScore?: number;
  limit?: number;
}

function usage(): string {
  return "usage: pnpm junk:scan --root <folder> [--out <path.json>] "
    + "[--outputs <dir>] [--limit <N>] [--min-score <0-100>]";
}

function parseCli(argv: string[]): CliOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const result = argv[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
  };
  const numeric = (flag: string): number | undefined => {
    const raw = value(flag);
    if (raw === undefined) return undefined;
    const result = Number(raw);
    if (!Number.isFinite(result)) throw new Error(`${flag} must be a number`);
    return result;
  };

  const root = value("--root");
  if (!root) throw new Error("--root is required");
  const out = value("--out") ?? resolve(process.cwd(), "outputs", "junk-candidates.json");
  if (extname(out).toLowerCase() !== ".json") {
    throw new Error("--out must be a .json path");
  }
  return {
    root,
    out,
    // Without this, the index-based signals (the strongest ones) silently
    // vanish whenever the tool is run from outside the repo root.
    outputsRoot: value("--outputs"),
    limit: numeric("--limit"),
    minScore: numeric("--min-score"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
  } else {
    try {
      const cli = parseCli(process.argv.slice(2));
      const outPath = resolve(cli.out);
      const report = scanJunkCandidates(cli.root, {
        limit: cli.limit,
        minScore: cli.minScore,
        outputsRoot: cli.outputsRoot,
      });
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      printSummary(report, outPath);
      logger.info("junk:scan complete", {
        candidates: report.candidates_reported,
        reclaimable_bytes: report.reclaimable_bytes,
        report: outPath,
      });
    } catch (err) {
      logger.error("junk:scan failed", { error: String(err) });
      logger.error(usage());
      process.exitCode = 1;
    }
  }
}
