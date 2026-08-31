import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contentTypeEnum, type ContentType } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import {
  footageCatalogSchema,
  type FootageCatalogScene,
} from "./rollup.js";

interface SearchOptions {
  catalog?: string;
  bRoll?: boolean;
  hasSpeech?: boolean;
  minDuration?: number;
  contentType?: ContentType;
  limit?: number;
}

interface CliOptions extends SearchOptions {
  query: string;
  json: boolean;
  help: boolean;
}

interface SearchMatch {
  term: string;
  matched_as: string;
  field: string;
  contribution: number;
}

export interface SearchResult {
  id: string;
  source_file: string;
  source_path: string | null;
  content_type: ContentType;
  has_speech: boolean;
  scene_index: number;
  start: number;
  end: number;
  duration: number;
  shot_type: FootageCatalogScene["shot_type"];
  setting: string;
  is_b_roll: boolean;
  description: string;
  spoken_excerpt: string | null;
  tags: string[];
  usable_for: string[];
  score: number;
  matched_terms: string[];
  why: string;
}

interface PreparedField {
  name: string;
  label: string;
  weight: number;
  normalized: string;
  compact: string;
  tokens: Set<string>;
  stems: Set<string>;
}

const FIELD_SPECS = [
  { name: "description", label: "description", weight: 10 },
  { name: "tags", label: "tags", weight: 9 },
  { name: "spoken_excerpt", label: "spoken excerpt", weight: 10 },
  { name: "shot_type", label: "shot type", weight: 7 },
  { name: "setting", label: "setting", weight: 6 },
  { name: "usable_for", label: "usable for", weight: 5 },
  { name: "summary", label: "clip summary", weight: 3 },
  { name: "people", label: "people", weight: 2 },
] as const;

const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "are",
  "clip",
  "clips",
  "do",
  "does",
  "find",
  "footage",
  "for",
  "from",
  "i",
  "is",
  "me",
  "need",
  "of",
  "scene",
  "scenes",
  "sec",
  "second",
  "seconds",
  "shot",
  "shots",
  "show",
  "the",
  "to",
  "video",
  "videos",
  "where",
  "with",
]);

// Small, transparent vocabulary bridges common editor phrasing to catalog tags.
// This is deliberately bounded: exact field evidence still drives every result.
const SYNONYM_GROUPS = [
  ["drone", "aerial", "overhead", "uav"],
  ["sunset", "dusk", "twilight", "golden hour", "evening"],
  ["exterior", "outdoor", "outside", "facade", "façade"],
  ["building", "clinic", "facility", "facade", "façade"],
  ["push", "push in", "approach", "forward", "glide", "advancing"],
  ["interior", "indoor", "inside"],
  ["doctor", "physician", "clinician", "의사", "원장님"],
  ["recovery", "healing", "downtime", "회복", "회복기간"],
  ["duration", "period", "time", "기간", "시간"],
  ["procedure", "treatment", "시술"],
] as const;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function englishStem(word: string): string {
  if (!/^[a-z]+$/u.test(word) || word.length < 4) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

const synonymMap = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const entry of group) {
    synonymMap.set(normalize(entry), group.map(normalize).filter((item) => item !== normalize(entry)));
  }
}

function fieldText(scene: FootageCatalogScene, field: (typeof FIELD_SPECS)[number]["name"]): string {
  const value = scene[field];
  return Array.isArray(value) ? value.join(" ") : (value ?? "");
}

function prepareFields(scene: FootageCatalogScene): PreparedField[] {
  return FIELD_SPECS.map((spec) => {
    const normalized = normalize(fieldText(scene, spec.name));
    const tokens = new Set(words(normalized));
    return {
      ...spec,
      normalized,
      compact: normalized.replaceAll(" ", ""),
      tokens,
      stems: new Set([...tokens].map(englishStem)),
    };
  });
}

function containsHangul(value: string): boolean {
  return /[\p{Script=Hangul}]/u.test(value);
}

function hangulBigramQuality(term: string, field: PreparedField): number {
  const chars = [...term.replaceAll(" ", "")];
  if (chars.length < 3) return 0;
  const grams = new Set(chars.slice(0, -1).map((char, i) => char + (chars[i + 1] ?? "")));
  const matched = [...grams].filter((gram) => field.compact.includes(gram)).length;
  const ratio = matched / grams.size;
  return ratio >= 0.5 ? 0.4 + ratio * 0.35 : 0;
}

function phrasePresent(field: PreparedField, value: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return false;
  return (` ${field.normalized} `).includes(` ${normalized} `);
}

function directMatchQuality(term: string, field: PreparedField): number {
  if (containsHangul(term)) {
    const compact = term.replaceAll(" ", "");
    if (field.compact.includes(compact)) return 1;
    return hangulBigramQuality(compact, field);
  }
  if (field.tokens.has(term)) return 1;
  if (field.stems.has(englishStem(term))) return 0.92;
  if (term.includes(" ") && phrasePresent(field, term)) return 1;
  return 0;
}

function matchTerm(term: string, field: PreparedField): { quality: number; matchedAs: string } {
  let quality = directMatchQuality(term, field);
  let matchedAs = term;
  for (const alias of synonymMap.get(term) ?? []) {
    const aliasQuality = directMatchQuality(alias, field) * 0.78;
    if (aliasQuality > quality) {
      quality = aliasQuality;
      matchedAs = alias;
    }
  }
  return { quality, matchedAs };
}

function queryTerms(query: string): string[] {
  const terms = words(query).filter((term) => {
    if (/^\d+$/u.test(term)) return false;
    if (/^[a-z]+$/u.test(term) && STOP_WORDS.has(term)) return false;
    return [...term].length >= 2;
  });
  return [...new Set(terms)];
}

function scoreScene(scene: FootageCatalogScene, query: string): SearchResult | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const fields = prepareFields(scene);
  const matches: SearchMatch[] = [];

  for (const term of terms) {
    let best: SearchMatch | null = null;
    for (const field of fields) {
      const { quality, matchedAs } = matchTerm(term, field);
      const contribution = quality * field.weight;
      if (contribution > (best?.contribution ?? 0)) {
        best = { term, matched_as: matchedAs, field: field.label, contribution };
      }
    }
    if (best) matches.push(best);
  }

  if (matches.length === 0) return null;
  const coverage = matches.length / terms.length;
  let score = matches.reduce((sum, match) => sum + match.contribution, 0);
  score *= 0.6 + coverage * 0.4;
  score += coverage * coverage * terms.length * 2;

  const phrase = terms.join(" ");
  if (terms.length > 1) {
    const phraseField = fields
      .filter((field) => phrasePresent(field, phrase))
      .sort((a, b) => b.weight - a.weight)[0];
    if (phraseField) {
      const bonus = phraseField.weight * 1.5;
      score += bonus;
      matches.push({
        term: phrase,
        matched_as: phrase,
        field: `${phraseField.label} phrase`,
        contribution: bonus,
      });
    } else if (containsHangul(phrase)) {
      const compactPhrase = phrase.replaceAll(" ", "");
      const compactField = fields
        .filter((field) => field.compact.includes(compactPhrase))
        .sort((a, b) => b.weight - a.weight)[0];
      if (compactField) {
        const bonus = compactField.weight * 1.25;
        score += bonus;
        matches.push({
          term: phrase,
          matched_as: compactPhrase,
          field: `${compactField.label} phrase`,
          contribution: bonus,
        });
      }
    }
  }

  const termMatches = matches.filter((match) => !match.field.endsWith(" phrase"));
  const why = matches
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5)
    .map((match) =>
      match.term === match.matched_as
        ? `“${match.term}” in ${match.field}`
        : `“${match.term}” via “${match.matched_as}” in ${match.field}`,
    )
    .join("; ");

  return {
    id: scene.id,
    source_file: scene.source_file,
    source_path: scene.source_path,
    content_type: scene.content_type,
    has_speech: scene.has_speech,
    scene_index: scene.scene_index,
    start: scene.start,
    end: scene.end,
    duration: scene.duration,
    shot_type: scene.shot_type,
    setting: scene.setting,
    is_b_roll: scene.is_b_roll,
    description: scene.description,
    spoken_excerpt: scene.spoken_excerpt,
    tags: scene.tags,
    usable_for: scene.usable_for,
    score: Number(score.toFixed(3)),
    matched_terms: [...new Set(termMatches.map((match) => match.term))],
    why,
  };
}

function passesFilters(scene: FootageCatalogScene, options: SearchOptions): boolean {
  if (options.bRoll !== undefined && scene.is_b_roll !== options.bRoll) return false;
  if (options.hasSpeech === true && !scene.has_speech) return false;
  if (options.minDuration !== undefined && scene.duration < options.minDuration) return false;
  if (options.contentType !== undefined && scene.content_type !== options.contentType) return false;
  return true;
}

export function searchCatalog(query: string, options: SearchOptions = {}): SearchResult[] {
  const catalogPath = resolve(options.catalog ?? join(process.cwd(), "outputs", "footage-catalog.json"));
  const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalog = footageCatalogSchema.parse(raw);
  const limit = options.limit ?? 10;

  return catalog.scenes
    .filter((scene) => passesFilters(scene, options))
    .map((scene) => scoreScene(scene, query))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score || b.duration - a.duration || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function finiteNumber(value: string, flag: string, integer = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${flag} must be a ${integer ? "non-negative integer" : "non-negative number"}`);
  }
  return parsed;
}

function parseCli(argv: string[]): CliOptions {
  const positional: string[] = [];
  const options: CliOptions = { query: "", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--b-roll") options.bRoll = true;
    else if (arg === "--no-b-roll") options.bRoll = false;
    else if (arg === "--has-speech") options.hasSpeech = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--catalog", "--min-duration", "--content-type", "--limit"].includes(arg)) {
      const value = requiredValue(argv, i, arg);
      i++;
      if (arg === "--catalog") options.catalog = value;
      else if (arg === "--min-duration") options.minDuration = finiteNumber(value, arg);
      else if (arg === "--limit") {
        const limit = finiteNumber(value, arg, true);
        if (limit < 1) throw new Error("--limit must be at least 1");
        options.limit = limit;
      } else {
        const parsed = contentTypeEnum.safeParse(value);
        if (!parsed.success) {
          throw new Error(`--content-type must be one of: ${contentTypeEnum.options.join(", ")}`);
        }
        options.contentType = parsed.data;
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (argv.includes("--b-roll") && argv.includes("--no-b-roll")) {
    throw new Error("--b-roll and --no-b-roll cannot be used together");
  }
  options.query = positional.join(" ").trim();
  return options;
}

function formatTimecode(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  return [hours, minutes, secs]
    .map((part) => String(part).padStart(2, "0"))
    .join(":") + `.${String(ms).padStart(3, "0")}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function printResults(results: SearchResult[]): void {
  if (results.length === 0) {
    process.stdout.write("No matching scenes.\n");
    return;
  }
  for (const [index, result] of results.entries()) {
    const source = result.source_path ?? result.source_file;
    process.stdout.write(
      `${index + 1}. ${source} @ ${formatTimecode(result.start)}–${formatTimecode(result.end)} ` +
        `(${result.duration.toFixed(1)}s, score ${result.score.toFixed(2)})\n` +
        `   ${oneLine(result.description)}\n` +
        `   Why: ${result.why}\n`,
    );
  }
}

function usage(): string {
  return (
    'usage: pnpm search "<query>" [--b-roll | --no-b-roll] [--has-speech] ' +
    "[--min-duration <sec>] [--content-type <type>] [--limit <N>] [--json] " +
    "[--catalog <file>]"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
    } else {
      if (!options.query) throw new Error("a search query is required");
      const results = searchCatalog(options.query, options);
      if (options.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      } else {
        printResults(results);
      }
    }
  } catch (err) {
    logger.error("search failed", { error: String(err) });
    logger.error(usage());
    process.exitCode = 1;
  }
}
