import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

export interface ResolvedMedia {
  /** Actual local file used for ffmpeg/ffprobe while the pack is built. */
  localPath: string;
  /** Stable slash-separated key stored in the portable review pack. */
  relativePath: string;
  /** Path Premiere should link on the editor's Mac (or other target machine). */
  targetPath: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function portable(path: string): string {
  return path.replaceAll("\\", "/");
}

function relativeInside(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return portable(rel);
}

export function joinTargetPath(targetRoot: string, relativePath: string): string {
  const rel = relativePath.replaceAll("\\", "/");
  // win32.isAbsolute('/Volumes/...') is also true on Windows, so POSIX must
  // win when the caller explicitly supplied a slash-rooted Mac path.
  if (posix.isAbsolute(targetRoot)) {
    return posix.join(targetRoot, ...rel.split("/"));
  }
  if (win32.isAbsolute(targetRoot) || targetRoot.includes("\\")) {
    return win32.join(targetRoot, ...rel.split("/"));
  }
  throw new Error(`target media root must be absolute: ${targetRoot}`);
}

/**
 * Resolve catalog basenames/old absolute paths against the media that is
 * actually mounted while the pack is built. The resulting relativePath is the
 * portable contract: a Windows build root can be replaced with a Mac root
 * without changing the shoot-folder/file identity.
 */
export class MediaLibrary {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  private readonly byBasename = new Map<string, string[]>();

  constructor(sourceRoot: string, targetRoot: string) {
    this.sourceRoot = resolve(sourceRoot);
    if (!isAbsolute(this.sourceRoot) || !statSync(this.sourceRoot).isDirectory()) {
      throw new Error(`source root is not a directory: ${this.sourceRoot}`);
    }
    if (!posix.isAbsolute(targetRoot) && !win32.isAbsolute(targetRoot)) {
      throw new Error(`target media root must be absolute: ${targetRoot}`);
    }
    const targetPathRoot = posix.parse(targetRoot).root === targetRoot || win32.parse(targetRoot).root === targetRoot;
    this.targetRoot = targetPathRoot ? targetRoot : targetRoot.replace(/[\\/]+$/u, "");
    this.index(this.sourceRoot);
  }

  private index(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`could not read media directory ${dir}: ${String(err)}`);
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.index(full);
      } else if (entry.isFile()) {
        const key = entry.name.toLocaleLowerCase("en-US");
        this.byBasename.set(key, [...(this.byBasename.get(key) ?? []), full]);
      }
    }
  }

  resolve(sourcePath: string | null | undefined, sourceFile: string): ResolvedMedia {
    let localPath: string | null = null;

    if (sourcePath && isFile(sourcePath)) {
      const absolute = resolve(sourcePath);
      if (relativeInside(this.sourceRoot, absolute) !== null) localPath = absolute;
    }

    if (!localPath) {
      const candidates = this.byBasename.get(basename(sourceFile).toLocaleLowerCase("en-US")) ?? [];
      if (candidates.length === 1) {
        localPath = candidates[0] ?? null;
      } else if (candidates.length > 1 && sourcePath) {
        const hint = portable(sourcePath).toLocaleLowerCase("en-US");
        const suffixMatches = candidates.filter((candidate) => {
          const rel = relativeInside(this.sourceRoot, candidate);
          return rel !== null && hint.endsWith(`/${rel.toLocaleLowerCase("en-US")}`);
        });
        if (suffixMatches.length === 1) localPath = suffixMatches[0] ?? null;
      }

      if (!localPath && candidates.length > 1) {
        const choices = candidates
          .map((candidate) => relativeInside(this.sourceRoot, candidate) ?? candidate)
          .join(", ");
        throw new Error(`ambiguous media basename ${sourceFile}; candidates: ${choices}`);
      }
    }

    if (!localPath) throw new Error(`media not found under ${this.sourceRoot}: ${sourceFile}`);
    const relativePath = relativeInside(this.sourceRoot, localPath);
    if (relativePath === null || relativePath.length === 0) {
      throw new Error(`media is outside source root: ${localPath}`);
    }
    return {
      localPath,
      relativePath,
      targetPath: joinTargetPath(this.targetRoot, relativePath),
    };
  }
}
