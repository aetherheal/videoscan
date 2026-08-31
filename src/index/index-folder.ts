import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import type { FootageIndex } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import { buildIndex } from "./build-index.js";
import { probeDuration } from "./scene-detect.js";

const VIDEO_EXTS = new Set([".mp4", ".mov"]);

// Resume state stays with the repo, not on the footage drive. The relative
// source directory is mirrored below this root so equal filenames in different
// shoot folders do not share a marker.
export const INDEX_STATE_DIR = resolve(process.cwd(), "outputs", "index-state");
const INDEX_OUTPUT_DIR = resolve(process.cwd(), "outputs");

export interface IndexDoneMarker {
  source_path: string;
  indexed_at: string;
  scene_count: number;
  content_type: FootageIndex["content_type"];
  asr: boolean;
}

export interface IndexFolderOptions {
  only?: string;
  skip?: string;
  limit?: number;
  overwrite?: boolean;
  asr?: boolean; // undefined = probe each file; true/false = force the whole run
  minDuration?: number;
  manifest?: string;
}

interface BackupManifestEntry {
  SourcePath: string;
  DestinationPaths: string[];
}

export interface ManifestVideo {
  sourcePath: string;
  videoPath?: string;
  error?: string;
  durationError?: string;
}

export interface AsrDecision {
  enabled: boolean;
  reason: string;
}

export interface ParsedIndexFolderArgs {
  folder?: string;
  options: IndexFolderOptions;
}

// Recursively list catalogable videos. Hidden directories are skipped to match
// the existing folder drivers, and AppleDouble sidecar files are never treated
// as footage even when their names end in .mp4/.mov.
export function walkVideos(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...walkVideos(full));
    } else if (
      entry.isFile() &&
      !entry.name.startsWith("._") &&
      VIDEO_EXTS.has(extname(entry.name).toLowerCase())
    ) {
      out.push(full);
    }
  }
  return out;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function manifestPath(rawPath: string, manifestDir: string): string {
  return resolve(isAbsolute(rawPath) ? rawPath : join(manifestDir, rawPath));
}

function parseManifestEntry(value: unknown, index: number): BackupManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Manifest entry ${index + 1} must be an object`);
  }

  const entry = value as Record<string, unknown>;
  if (typeof entry.SourcePath !== "string" || entry.SourcePath.length === 0) {
    throw new Error(`Manifest entry ${index + 1} has an invalid SourcePath`);
  }
  if (
    !Array.isArray(entry.DestinationPaths) ||
    !entry.DestinationPaths.every((path) => typeof path === "string")
  ) {
    throw new Error(`Manifest entry ${index + 1} has invalid DestinationPaths`);
  }

  return {
    SourcePath: entry.SourcePath,
    DestinationPaths: entry.DestinationPaths,
  };
}

// Prefer the first backup destination that is currently present. A missing
// record remains in the plan as a failed item so it cannot abort every other
// clip named by a many-hour batch.
export function readManifestVideos(path: string): ManifestVideo[] {
  const resolvedManifest = resolve(path);
  const manifestDir = dirname(resolvedManifest);
  const raw = readFileSync(resolvedManifest, "utf8").replace(/^\uFEFF/, "");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Footage manifest must contain a JSON array");

  return parsed.map((value, index): ManifestVideo => {
    const entry = parseManifestEntry(value, index);
    const sourcePath = manifestPath(entry.SourcePath, manifestDir);
    const destinations = entry.DestinationPaths.map((candidate) =>
      manifestPath(candidate, manifestDir),
    );
    const destination = destinations.find(isFile);
    if (destination) return { sourcePath, videoPath: destination };
    if (isFile(sourcePath)) return { sourcePath, videoPath: sourcePath };
    return {
      sourcePath,
      error:
        `Manifest entry ${index + 1} has no existing DestinationPaths ` +
        `or SourcePath: ${entry.SourcePath}`,
    };
  });
}

function isBelowRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function stateRelativePath(videoPath: string, sourceRoot?: string): string {
  const absoluteVideo = resolve(videoPath);
  if (sourceRoot) {
    const absoluteRoot = resolve(sourceRoot);
    if (isBelowRoot(absoluteVideo, absoluteRoot)) return relative(absoluteRoot, absoluteVideo);
  }

  // A manifest can fall back to SourcePath on another drive. Keep that marker
  // inside index-state while retaining a stable, collision-resistant hierarchy.
  const pathParts = parse(absoluteVideo);
  const rootName = pathParts.root.replace(/[^a-zA-Z0-9._-]+/g, "_") || "root";
  return join("_absolute", rootName, relative(pathParts.root, absoluteVideo));
}

export function markerPathFor(
  videoPath: string,
  sourceRoot?: string,
  stateDir: string = INDEX_STATE_DIR,
): string {
  const statePath = stateRelativePath(videoPath, sourceRoot);
  const parts = parse(statePath);
  return join(stateDir, parts.dir, `${parts.name}.index.json`);
}

function isIndexDoneMarker(value: unknown): value is IndexDoneMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.source_path === "string" &&
    typeof marker.indexed_at === "string" &&
    typeof marker.scene_count === "number" &&
    Number.isInteger(marker.scene_count) &&
    marker.scene_count >= 0 &&
    typeof marker.content_type === "string" &&
    typeof marker.asr === "boolean"
  );
}

export function readIndexMarker(path: string): IndexDoneMarker {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isIndexDoneMarker(parsed)) throw new Error(`Invalid index done-marker: ${path}`);
  return parsed;
}

export function writeIndexMarker(path: string, marker: IndexDoneMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2), "utf8");
}

// Treat an ffprobe failure as a per-item error, not as evidence of silence.
// Otherwise a transient/corrupt probe could silently drop real speech.
export function probeHasAudio(videoPath: string): boolean {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(`ffprobe audio-stream check failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim().length > 0;
}

export function decideAsr(videoPath: string, forced?: boolean): AsrDecision {
  if (forced === true) return { enabled: true, reason: "forced by --asr" };
  if (forced === false) return { enabled: false, reason: "forced by --no-asr" };
  return probeHasAudio(videoPath)
    ? { enabled: true, reason: "audio stream detected by ffprobe" }
    : { enabled: false, reason: "no audio stream detected by ffprobe" };
}

export function shouldUseAsr(videoPath: string, forced?: boolean): boolean {
  return decideAsr(videoPath, forced).enabled;
}

function candidateName(candidate: ManifestVideo): string {
  return basename(candidate.videoPath ?? candidate.sourcePath);
}

function candidateSortPath(candidate: ManifestVideo): string {
  return candidate.videoPath ?? candidate.sourcePath;
}

function isCatalogableVideo(candidate: ManifestVideo): boolean {
  const name = candidateName(candidate);
  return !name.startsWith("._") && VIDEO_EXTS.has(extname(name).toLowerCase());
}

function deduplicateCandidates(candidates: ManifestVideo[]): ManifestVideo[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const rawKey = candidate.videoPath ?? `missing:${candidate.sourcePath}`;
    const key = process.platform === "win32" ? rawKey.toLowerCase() : rawKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateOptions(opts: IndexFolderOptions): void {
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new Error("--limit must be a non-negative integer");
  }
  if (
    opts.minDuration !== undefined &&
    (!Number.isFinite(opts.minDuration) || opts.minDuration < 0)
  ) {
    throw new Error("--min-duration must be a non-negative number");
  }
}

// Batch the existing per-video catalog pipeline. Items are deliberately
// sequential: ffmpeg/ASR are resource-heavy, and a marker is written only after
// the full index succeeds.
//
// Usage:
//   pnpm index:folder "<folder>" [--manifest path.json] [--only s] [--skip s]
//                     [--limit N] [--overwrite] [--asr | --no-asr]
//                     [--min-duration sec]
// A folder may be omitted when --manifest is supplied; absolute source paths
// are then mirrored safely below outputs/index-state/_absolute/.
export async function indexFolder(
  folder: string | undefined,
  opts: IndexFolderOptions = {},
): Promise<void> {
  validateOptions(opts);
  if (!folder && !opts.manifest) throw new Error("A folder or --manifest is required");

  const sourceRoot = folder ? resolve(folder) : undefined;
  if (
    sourceRoot &&
    (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory())
  ) {
    throw new Error(`Folder is not an existing directory: ${sourceRoot}`);
  }
  const manifest = opts.manifest ? resolve(opts.manifest) : undefined;
  const discovered: ManifestVideo[] = manifest
    ? readManifestVideos(manifest)
    : walkVideos(sourceRoot as string).map((videoPath) => ({
        sourcePath: videoPath,
        videoPath,
      }));
  const all = deduplicateCandidates(discovered)
    .filter(isCatalogableVideo)
    .filter((candidate) =>
      opts.only ? candidateName(candidate).includes(opts.only) : true,
    )
    .filter((candidate) =>
      opts.skip ? !candidateName(candidate).includes(opts.skip) : true,
    )
    .sort((a, b) => candidateSortPath(a).localeCompare(candidateSortPath(b)));

  let skippedExisting = 0;
  const pending = all.filter((candidate) => {
    const exists =
      candidate.videoPath !== undefined &&
      !opts.overwrite &&
      existsSync(markerPathFor(candidate.videoPath, sourceRoot));
    if (exists) skippedExisting++;
    return !exists;
  });

  // Apply the duration gate before --limit so "the first N long-form clips"
  // does not accidentally mean "the first N paths, most of which were short."
  let skippedDuration = 0;
  let eligible = pending;
  if (opts.minDuration !== undefined) {
    eligible = [];
    for (const [i, candidate] of pending.entries()) {
      const file = candidateName(candidate);
      logger.info(`index:folder duration probe [${i + 1}/${pending.length}]`, { file });
      if (!candidate.videoPath) {
        eligible.push(candidate);
        continue;
      }

      const duration = probeDuration(candidate.videoPath);
      if (duration <= 0) {
        candidate.durationError = `Could not read duration for ${candidate.videoPath}`;
        eligible.push(candidate);
      } else if (duration < opts.minDuration) {
        skippedDuration++;
        logger.info("index:folder skipped (under --min-duration)", {
          file,
          duration_seconds: Number(duration.toFixed(3)),
          min_duration_seconds: opts.minDuration,
        });
      } else {
        eligible.push(candidate);
      }
    }
  }

  const slice = opts.limit !== undefined ? eligible.slice(0, opts.limit) : eligible;

  logger.info("index:folder plan", {
    folder: sourceRoot ?? null,
    manifest: manifest ?? null,
    videos: all.length,
    pending: pending.length,
    willProcess: slice.length,
    state_dir: INDEX_STATE_DIR,
    asr_policy:
      opts.asr === true
        ? "forced on"
        : opts.asr === false
          ? "forced off"
          : "probe audio per file",
    min_duration_seconds: opts.minDuration ?? null,
  });

  let done = 0;
  let failed = 0;
  let withAsr = 0;
  let withoutAsr = 0;
  for (const [i, candidate] of slice.entries()) {
    const file = candidateName(candidate);
    logger.info(`index:folder [${i + 1}/${slice.length}]`, { file });

    try {
      if (!candidate.videoPath) {
        throw new Error(candidate.error ?? "Manifest video does not exist");
      }
      if (candidate.durationError) throw new Error(candidate.durationError);

      const asr = decideAsr(candidate.videoPath, opts.asr);
      logger.info("index:folder ASR policy", {
        file,
        asr: asr.enabled ? "on" : "off",
        reason: asr.reason,
      });
      if (asr.enabled) withAsr++;
      else withoutAsr++;

      const index = await buildIndex(candidate.videoPath, {
        asr: asr.enabled,
        outRoot: INDEX_OUTPUT_DIR,
      });
      const markerPath = markerPathFor(candidate.videoPath, sourceRoot);
      writeIndexMarker(markerPath, {
        source_path: resolve(candidate.videoPath),
        indexed_at: new Date().toISOString(),
        scene_count: index.scenes.length,
        content_type: index.content_type,
        asr: asr.enabled,
      });
      done++;
      logger.info("index:folder item done", {
        file,
        scenes: index.scenes.length,
        content_type: index.content_type,
        marker: markerPath,
      });
    } catch (err) {
      failed++;
      logger.error("index:folder item failed", { file, error: String(err) });
    }
  }

  logger.info("index:folder complete", {
    done,
    failed,
    skipped_existing: skippedExisting,
    with_asr: withAsr,
    without_asr: withoutAsr,
    skipped_duration: skippedDuration,
  });
}

function flagValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

export function parseIndexFolderArgs(argv: string[]): ParsedIndexFolderArgs {
  const options: IndexFolderOptions = {};
  let folder: string | undefined;
  let forcedAsr: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case "--only":
        options.only = flagValue(argv, i);
        i++;
        break;
      case "--skip":
        options.skip = flagValue(argv, i);
        i++;
        break;
      case "--limit": {
        const rawLimit = flagValue(argv, i);
        const limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error(`--limit must be a non-negative integer, received: ${rawLimit}`);
        }
        options.limit = limit;
        i++;
        break;
      }
      case "--min-duration": {
        const rawDuration = flagValue(argv, i);
        const minDuration = Number(rawDuration);
        if (!Number.isFinite(minDuration) || minDuration < 0) {
          throw new Error(
            `--min-duration must be a non-negative number, received: ${rawDuration}`,
          );
        }
        options.minDuration = minDuration;
        i++;
        break;
      }
      case "--manifest":
        options.manifest = flagValue(argv, i);
        i++;
        break;
      case "--overwrite":
        options.overwrite = true;
        break;
      case "--asr":
        if (forcedAsr === false) throw new Error("--asr and --no-asr cannot be used together");
        forcedAsr = true;
        break;
      case "--no-asr":
        if (forcedAsr === true) throw new Error("--asr and --no-asr cannot be used together");
        forcedAsr = false;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        if (folder !== undefined) throw new Error(`Unexpected positional argument: ${arg}`);
        folder = arg;
    }
  }

  if (forcedAsr !== undefined) options.asr = forcedAsr;
  if (!folder && !options.manifest) throw new Error("A folder or --manifest is required");
  validateOptions(options);
  return { folder, options };
}

const USAGE =
  'usage: pnpm index:folder "<folder>" [--manifest path.json] [--only s] [--skip s] ' +
  "[--limit N] [--overwrite] [--asr | --no-asr] [--min-duration sec]";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed: ParsedIndexFolderArgs;
  try {
    parsed = parseIndexFolderArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(USAGE, { error: String(err) });
    process.exit(1);
  }

  indexFolder(parsed.folder, parsed.options).catch((err: unknown) => {
    logger.error("index:folder failed", { error: String(err) });
    process.exit(1);
  });
}
