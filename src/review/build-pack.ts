import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { clipManifestSchema, type ClipSpec } from "../config/schema.js";
import { asrEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { footageCatalogSchema, type FootageCatalogScene } from "../index/rollup.js";
import { searchCatalog, type SearchResult } from "../index/search.js";
import { buildReviewHtml, type ReviewPageItem, type ReviewPageLink, type ReviewPagePayload } from "./html.js";
import { MediaLibrary, type ResolvedMedia } from "./media-map.js";

const DEFAULT_SCENE_LIMIT = 50;
const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_VIRAL_LIMIT = 20;
const DEFAULT_PROXY_HEIGHT = 360;

interface InternalReviewItem extends ReviewPageItem {
  localPath: string;
}

interface EditListClip {
  path: string;
  target_path: string;
  in: number;
  out: number;
  name: string;
  description: string;
}

interface EditList {
  name: string;
  clips: EditListClip[];
}

export interface BuildReviewPackOptions {
  sourceRoot: string;
  targetRoot: string;
  catalogPath?: string;
  shortsRoot?: string;
  outDir?: string;
  name?: string;
  queries?: string[];
  limitPerQuery?: number;
  maxScenes?: number;
  viralLimit?: number;
  proxyHeight?: number;
  generateProxies?: boolean;
  generateXml?: boolean;
}

export interface BuildReviewPackResult {
  outDir: string;
  htmlPath: string;
  dataPath: string;
  itemCount: number;
  viralCount: number;
  sceneCount: number;
  xmlPaths: string[];
  proxyCount: number;
  warnings: string[];
}

function walkFiles(root: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(entry.name)) out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

function parseTimecode(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u);
  if (!match) throw new Error(`invalid timecode: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function stableId(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 18);
}

function segmentKey(item: Pick<InternalReviewItem, "source_relative" | "start" | "end">): string {
  return stableId([item.source_relative, item.start.toFixed(3), item.end.toFixed(3)]);
}

function safeName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 55);
  return cleaned || "Selects";
}

function resolveMedia(
  library: MediaLibrary,
  sourcePath: string | null | undefined,
  sourceFile: string,
  warnings: string[],
): ResolvedMedia | null {
  try {
    return library.resolve(sourcePath, sourceFile);
  } catch (err) {
    const message = String(err);
    // A catalog commonly covers more than the shoot folder selected for this
    // pack. Missing basenames are an ordinary filter, not hundreds of warnings.
    if (!message.includes("media not found under")) warnings.push(message);
    return null;
  }
}

function sceneItem(
  scene: FootageCatalogScene | SearchResult,
  group: string,
  media: ResolvedMedia,
): InternalReviewItem {
  const score = "score" in scene ? scene.score : undefined;
  return {
    id: stableId(["scene", group, media.relativePath, scene.start.toFixed(3), scene.end.toFixed(3)]),
    kind: "scene",
    group,
    source_file: scene.source_file,
    source_relative: media.relativePath,
    target_path: media.targetPath,
    localPath: media.localPath,
    start: scene.start,
    end: scene.end,
    duration: Math.max(0, scene.end - scene.start),
    description: scene.description,
    spoken_excerpt: scene.spoken_excerpt,
    tags: scene.tags,
    content_type: scene.content_type,
    shot_type: scene.shot_type,
    is_b_roll: scene.is_b_roll,
    proxy_path: null,
    ...(score === undefined ? {} : { score }),
    flags: [],
  };
}

function viralItem(clip: ClipSpec, media: ResolvedMedia): InternalReviewItem {
  const start = parseTimecode(clip.start);
  const end = parseTimecode(clip.end);
  const flags: string[] = [];
  if (clip.brand_safety === "review") flags.push("브랜드 검토");
  if (clip.reframe_advice === "manual-review") flags.push("영상 확인");
  const spoken = clip.captions.map((caption) => caption.text.trim()).filter(Boolean).join(" ");
  return {
    id: stableId(["viral", media.relativePath, start.toFixed(3), end.toFixed(3)]),
    kind: "viral",
    group: "바이럴 후보",
    source_file: clip.source_file,
    source_relative: media.relativePath,
    target_path: media.targetPath,
    localPath: media.localPath,
    start,
    end,
    duration: Math.max(0, end - start),
    description: clip.virality_rationale,
    spoken_excerpt: spoken || null,
    tags: [clip.hook_type, clip.shareability_driver],
    content_type: "viral_short",
    shot_type: clip.reframe_advice,
    is_b_roll: false,
    proxy_path: null,
    virality_score: clip.virality_score,
    hook_overlay: clip.hook_overlay,
    payoff_line: clip.payoff_line,
    flags,
  };
}

function collectViralItems(
  shortsRoot: string,
  library: MediaLibrary,
  limit: number,
  warnings: string[],
): InternalReviewItem[] {
  const items: InternalReviewItem[] = [];
  for (const manifestPath of walkFiles(shortsRoot, (name) => name.endsWith(".shorts.json"))) {
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const clips = clipManifestSchema.parse(raw);
      const manifestDir = dirname(relative(shortsRoot, manifestPath));
      for (const clip of clips) {
        // scan:folder state mirrors the source folder, so this hint resolves
        // repeated camera basenames without guessing when that layout exists.
        const sourceHint = join(library.sourceRoot, manifestDir, clip.source_file);
        const media = resolveMedia(library, sourceHint, clip.source_file, warnings);
        if (media) items.push(viralItem(clip, media));
      }
    } catch (err) {
      warnings.push(`could not read shorts manifest ${basename(manifestPath)}: ${String(err)}`);
    }
  }

  const unique = new Map<string, InternalReviewItem>();
  for (const item of items.sort((a, b) => (b.virality_score ?? 0) - (a.virality_score ?? 0))) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].slice(0, limit);
}

function collectSceneItems(
  catalogPath: string,
  queries: string[],
  library: MediaLibrary,
  limitPerQuery: number,
  maxScenes: number,
  warnings: string[],
): InternalReviewItem[] {
  if (queries.length > 0) {
    const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
    const catalog = footageCatalogSchema.parse(raw);
    const items: InternalReviewItem[] = [];
    for (const query of queries) {
      const matches = searchCatalog(query, {
        catalog: catalogPath,
        // Search the complete catalog first, then apply the selected source
        // root. Otherwise the global top N may all belong to another shoot and
        // hide valid matches in this pack's folder.
        limit: Math.max(1, catalog.scene_count),
        maxPerClip: 2,
      });
      let accepted = 0;
      for (const match of matches) {
        if (accepted >= limitPerQuery) break;
        const media = resolveMedia(library, match.source_path, match.source_file, warnings);
        if (media) {
          items.push(sceneItem(match, `검색 · ${query}`, media));
          accepted++;
        }
      }
    }
    return items.slice(0, maxScenes);
  }

  const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalog = footageCatalogSchema.parse(raw);
  const items: InternalReviewItem[] = [];
  const ordered = [...catalog.scenes].sort(
    (a, b) => a.source_file.localeCompare(b.source_file) || a.start - b.start,
  );
  for (const scene of ordered) {
    if (items.length >= maxScenes) break;
    const media = resolveMedia(library, scene.source_path, scene.source_file, warnings);
    if (media) items.push(sceneItem(scene, "장면 셀렉트", media));
  }
  return items;
}

function createProxy(item: InternalReviewItem, proxyPath: string, height: number): string | null {
  if (existsSync(proxyPath)) return null;
  const duration = Math.max(0.1, item.end - item.start);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", item.start.toFixed(3), "-i", item.localPath,
      "-t", duration.toFixed(3),
      // Some iPhone MOVs expose a non-decodable auxiliary stream alongside the
      // real audio. Map only the first optional audio stream, never every one.
      "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
      "-vf", `scale=-2:${height}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
      proxyPath,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    logger.warn("review proxy failed", {
      source: item.source_relative,
      start: item.start,
      error: result.error?.message ?? result.stderr.trim() ?? `ffmpeg exit ${result.status}`,
    });
    // Keep local absolute source/output paths out of the portable pack. The
    // detailed ffmpeg diagnostic remains in the build-machine log above.
    return `프록시 생성 실패: ${item.source_relative} @ ${item.start.toFixed(3)} ` +
      `(ffmpeg exit ${result.status ?? "launch-error"})`;
  }
  return null;
}

function attachProxies(
  items: InternalReviewItem[],
  outDir: string,
  height: number,
  warnings: string[],
): number {
  const proxyDir = join(outDir, "proxies");
  mkdirSync(proxyDir, { recursive: true });
  const generated = new Set<string>();
  const failures = new Set<string>();
  for (const item of items) {
    const key = segmentKey(item);
    const name = `${key}.mp4`;
    const proxyPath = join(proxyDir, name);
    if (!generated.has(key) && !failures.has(key)) {
      const warning = createProxy(item, proxyPath, height);
      if (warning) {
        failures.add(key);
        warnings.push(warning);
      } else {
        generated.add(key);
      }
    }
    if (generated.has(key) || existsSync(proxyPath)) item.proxy_path = `proxies/${name}`;
  }
  return generated.size;
}

function editDescription(item: InternalReviewItem): string {
  const parts = [item.group, item.description];
  if (item.hook_overlay) parts.push(`Hook: ${item.hook_overlay}`);
  if (item.payoff_line) parts.push(`Payoff: ${item.payoff_line}`);
  if (item.flags.length) parts.push(`Flags: ${item.flags.join(", ")}`);
  return parts.join(" | ");
}

function writePremiereXml(
  name: string,
  items: InternalReviewItem[],
  outPath: string,
): void {
  const editList: EditList = {
    name,
    clips: items.map((item) => ({
      path: item.localPath,
      target_path: item.target_path,
      in: item.start,
      out: item.end,
      name: item.source_file,
      description: editDescription(item),
    })),
  };
  const scratch = mkdtempSync(join(tmpdir(), "videoscan-fcpxml-"));
  const editListPath = join(scratch, "editlist.json");
  try {
    writeFileSync(editListPath, JSON.stringify(editList, null, 2), "utf8");
    const script = resolve(process.cwd(), "python", "build_fcpxml.py");
    const result = spawnSync(asrEnv().python, [script, editListPath, outPath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `FCP7 XML generation failed: ${result.error?.message ?? result.stderr.trim() ?? result.stdout.trim()}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function xmlReadableItems(items: InternalReviewItem[], warnings: string[]): InternalReviewItem[] {
  const probeCache = new Map<string, boolean>();
  const warned = new Set<string>();
  return items.filter((item) => {
    let readable = probeCache.get(item.localPath);
    if (readable === undefined) {
      const probe = spawnSync(
        "ffprobe",
        [
          "-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=width", "-of", "csv=p=0",
          item.localPath,
        ],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      );
      readable = !probe.error && probe.status === 0 && probe.stdout.trim().length > 0;
      probeCache.set(item.localPath, readable);
    }
    if (!readable) {
      if (!item.flags.includes("원본 읽기 실패")) item.flags.push("원본 읽기 실패");
      if (!warned.has(item.source_relative)) {
        warnings.push(`Premiere XML에서 읽을 수 없는 원본 제외: ${item.source_relative}`);
        warned.add(item.source_relative);
      }
    }
    return readable;
  });
}

function xmlGroups(items: InternalReviewItem[]): Array<{ name: string; file: string; items: InternalReviewItem[] }> {
  const groups = new Map<string, InternalReviewItem[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const names = [...groups.keys()].sort((a, b) => {
    if (a === "바이럴 후보") return -1;
    if (b === "바이럴 후보") return 1;
    return a.localeCompare(b);
  });
  return names.map((name, index) => ({
    name,
    file: `${String(index + 1).padStart(2, "0")}_${safeName(name)}.xml`,
    items: groups.get(name) ?? [],
  }));
}

function publicItem(item: InternalReviewItem): ReviewPageItem {
  const { localPath: _localPath, ...portableItem } = item;
  return portableItem;
}

export function buildReviewPack(opts: BuildReviewPackOptions): BuildReviewPackResult {
  const sourceRoot = resolve(opts.sourceRoot);
  const catalogPath = resolve(opts.catalogPath ?? join(process.cwd(), "outputs", "footage-catalog.json"));
  const shortsRoot = resolve(opts.shortsRoot ?? join(process.cwd(), "outputs", "scan-state"));
  const outDir = resolve(opts.outDir ?? join(process.cwd(), "outputs", "pd-select-pack"));
  const queries = (opts.queries ?? []).map((query) => query.trim()).filter(Boolean);
  const warnings: string[] = [];

  if (!existsSync(catalogPath)) throw new Error(`footage catalog does not exist: ${catalogPath}`);
  const library = new MediaLibrary(sourceRoot, opts.targetRoot);
  const viral = collectViralItems(shortsRoot, library, opts.viralLimit ?? DEFAULT_VIRAL_LIMIT, warnings);
  const scenes = collectSceneItems(
    catalogPath,
    queries,
    library,
    opts.limitPerQuery ?? DEFAULT_QUERY_LIMIT,
    opts.maxScenes ?? DEFAULT_SCENE_LIMIT,
    warnings,
  );
  const items = [...viral, ...scenes];
  if (items.length === 0) {
    throw new Error("no reviewable clips resolved under the selected source root");
  }

  mkdirSync(outDir, { recursive: true });
  const proxyCount = opts.generateProxies === false
    ? 0
    : attachProxies(items, outDir, opts.proxyHeight ?? DEFAULT_PROXY_HEIGHT, warnings);

  const links: ReviewPageLink[] = [];
  const xmlPaths: string[] = [];
  if (opts.generateXml !== false) {
    // A single offline Drive placeholder or corrupt MP4 must not discard the
    // entire handoff. Keep its card/diagnostic in HTML, but build Premiere reels
    // from the source files ffprobe can actually read right now.
    const readableItems = xmlReadableItems(items, warnings);
    for (const group of xmlGroups(readableItems)) {
      if (group.items.length === 0) continue;
      const xmlPath = join(outDir, group.file);
      writePremiereXml(group.name, group.items, xmlPath);
      xmlPaths.push(xmlPath);
      links.push({ label: `Premiere · ${group.name}`, href: group.file, count: group.items.length });
    }
  }

  const name = opts.name ?? `${basename(sourceRoot)} · PD Select Pack`;
  const payload: ReviewPagePayload = {
    version: 1,
    name,
    generated_at: new Date().toISOString(),
    target_media_root: opts.targetRoot,
    items: items.map(publicItem),
    premiere_xml: links,
    warnings,
  };
  const dataPath = join(outDir, "pack-data.json");
  const htmlPath = join(outDir, "OPEN_ME.html");
  writeFileSync(dataPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(htmlPath, buildReviewHtml(payload), "utf8");
  writeFileSync(
    join(outDir, "README.txt"),
    [
      "VIDEO SCAN · PD SELECT PACK",
      "",
      "1. OPEN_ME.html을 더블클릭합니다.",
      "2. 프록시를 보고 채택/보류/제외와 메모를 남깁니다.",
      "3. '검토 결과 저장'으로 pd-review.json을 보관합니다.",
      "4. 필요한 XML을 Premiere의 File > Import로 가져옵니다.",
      "",
      `Premiere media root: ${opts.targetRoot}`,
      "미디어가 연결되지 않으면 이 루트만 올바른 Google Drive/외장 디스크 경로로 relink하세요.",
    ].join("\n") + "\n",
    "utf8",
  );

  logger.info("PD Select Pack written", {
    out: outDir,
    items: items.length,
    viral: viral.length,
    scenes: scenes.length,
    proxies: proxyCount,
    premiere_xml: xmlPaths.length,
    warnings: warnings.length,
  });
  return {
    outDir,
    htmlPath,
    dataPath,
    itemCount: items.length,
    viralCount: viral.length,
    sceneCount: scenes.length,
    xmlPaths,
    proxyCount,
    warnings,
  };
}

interface CliOptions extends Partial<BuildReviewPackOptions> {
  help: boolean;
}

function requiredValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
  return value;
}

function nonNegativeInteger(value: string, flag: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function parseReviewPackArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-proxies") options.generateProxies = false;
    else if (arg === "--no-xml") options.generateXml = false;
    else if (["--source-root", "--media-root", "--catalog", "--shorts-root", "--out", "--name", "--query", "--limit", "--max-scenes", "--viral-limit", "--proxy-height"].includes(arg)) {
      const value = requiredValue(argv, i);
      i++;
      if (arg === "--source-root") options.sourceRoot = value;
      else if (arg === "--media-root") options.targetRoot = value;
      else if (arg === "--catalog") options.catalogPath = value;
      else if (arg === "--shorts-root") options.shortsRoot = value;
      else if (arg === "--out") options.outDir = value;
      else if (arg === "--name") options.name = value;
      else if (arg === "--query") options.queries = [...(options.queries ?? []), value];
      else if (arg === "--limit") options.limitPerQuery = nonNegativeInteger(value, arg, 1);
      else if (arg === "--max-scenes") options.maxScenes = nonNegativeInteger(value, arg, 1);
      else if (arg === "--viral-limit") options.viralLimit = nonNegativeInteger(value, arg);
      else if (arg === "--proxy-height") options.proxyHeight = nonNegativeInteger(value, arg, 64);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    "usage: pnpm review:pack --source-root <local-media-dir> --media-root <mac-media-dir>",
    "  [--catalog <footage-catalog.json>] [--shorts-root <scan-state-dir>] [--out <dir>]",
    "  [--query <text>]... [--limit <per-query>] [--max-scenes <N>] [--viral-limit <N>]",
    "  [--proxy-height <px>] [--no-proxies] [--no-xml] [--name <pack-name>]",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseReviewPackArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
    } else {
      if (!options.sourceRoot) throw new Error("--source-root is required");
      if (!options.targetRoot) throw new Error("--media-root is required");
      const result = buildReviewPack(options as BuildReviewPackOptions);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } catch (err) {
    logger.error("review:pack failed", { error: String(err) });
    logger.error(usage());
    process.exitCode = 1;
  }
}
