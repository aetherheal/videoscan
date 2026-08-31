import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  contentTypeEnum,
  footageIndexSchema,
  shotTypeEnum,
} from "../config/schema.js";
import { logger } from "../utils/logger.js";

const INDEX_FILENAME = "footage-index.json";
const CATALOG_FILENAME = "footage-catalog.json";

export const footageCatalogSceneSchema = z.object({
  id: z.string(),
  index_file: z.string(),
  source_file: z.string(),
  source_path: z.string().nullable(),
  clip_duration: z.number().nonnegative(),
  summary: z.string(),
  content_type: contentTypeEnum,
  language: z.string(),
  has_speech: z.boolean(),
  scene_index: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  shot_type: shotTypeEnum,
  setting: z.string(),
  description: z.string(),
  people: z.array(z.string()),
  is_b_roll: z.boolean(),
  spoken_excerpt: z.string().nullable(),
  tags: z.array(z.string()),
  usable_for: z.array(z.string()),
});

export const footageCatalogSchema = z.object({
  version: z.literal(1),
  clip_count: z.number().int().nonnegative(),
  scene_count: z.number().int().nonnegative(),
  scenes: z.array(footageCatalogSceneSchema),
});

export type FootageCatalogScene = z.infer<typeof footageCatalogSceneSchema>;
export type FootageCatalog = z.infer<typeof footageCatalogSchema>;

export interface RollupOptions {
  root?: string;
  out?: string;
}

export interface RollupResult {
  catalog: FootageCatalog;
  outPath: string;
  failed: number;
  changed: boolean;
}

function walkIndexes(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === INDEX_FILENAME) found.push(path);
    }
  };
  visit(root);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// buildIndex currently stores a basename. Resolve it only when a real file at a
// conventional location makes the relationship unambiguous; never invent an
// absolute path that merely looks plausible.
function resolveSourcePath(indexPath: string, root: string, sourceFile: string): string | null {
  if (isAbsolute(sourceFile)) return resolve(sourceFile);

  const candidates = [
    resolve(dirname(indexPath), sourceFile),
    resolve(root, sourceFile),
    resolve(process.cwd(), sourceFile),
    resolve(process.cwd(), "inputs", sourceFile),
    resolve(dirname(root), "inputs", sourceFile),
  ];
  return candidates.find(isFile) ?? null;
}

function portableRelativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

export function rollupFootageIndexes(opts: RollupOptions = {}): RollupResult {
  const root = resolve(opts.root ?? join(process.cwd(), "outputs"));
  const outPath = resolve(opts.out ?? join(root, CATALOG_FILENAME));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`rollup root is not a directory: ${root}`);
  }

  const scenes: FootageCatalogScene[] = [];
  let clipCount = 0;
  let failed = 0;

  for (const indexPath of walkIndexes(root)) {
    const indexFile = portableRelativePath(root, indexPath);
    try {
      const raw: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
      const clip = footageIndexSchema.parse(raw);
      const sourcePath = resolveSourcePath(indexPath, root, clip.source_file);

      clip.scenes.forEach((scene, scenePosition) => {
        scenes.push({
          id: `${indexFile}#scene-${scene.index}-${scenePosition}`,
          index_file: indexFile,
          source_file: clip.source_file,
          source_path: sourcePath,
          clip_duration: clip.duration,
          summary: clip.summary,
          content_type: clip.content_type,
          language: clip.language,
          has_speech: clip.has_speech,
          scene_index: scene.index,
          start: scene.start,
          end: scene.end,
          duration: Math.max(0, scene.end - scene.start),
          shot_type: scene.shot_type,
          setting: scene.setting,
          description: scene.description,
          people: scene.people,
          is_b_roll: scene.is_b_roll,
          spoken_excerpt: scene.spoken_excerpt,
          tags: scene.tags,
          usable_for: scene.usable_for,
        });
      });
      clipCount++;
    } catch (err) {
      failed++;
      logger.error("index:rollup item failed", { index_file: indexFile, error: String(err) });
    }
  }

  const catalog = footageCatalogSchema.parse({
    version: 1,
    clip_count: clipCount,
    scene_count: scenes.length,
    scenes,
  });
  const serialized = JSON.stringify(catalog, null, 2) + "\n";
  const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  const changed = previous !== serialized;
  if (changed) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized, "utf8");
  }

  logger.info(changed ? "footage catalog written" : "footage catalog unchanged", {
    out: outPath,
    clips: clipCount,
    scenes: scenes.length,
    failed,
  });
  return { catalog, outPath, failed, changed };
}

interface CliOptions extends RollupOptions {
  help: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root" || arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      if (arg === "--root") options.root = value;
      else options.out = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return "usage: pnpm index:rollup [--root <dir>] [--out <file>]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
    } else {
      rollupFootageIndexes(options);
    }
  } catch (err) {
    logger.error("index:rollup failed", { error: String(err) });
    logger.error(usage());
    process.exitCode = 1;
  }
}
