import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Lazy env reader. Call env() at use-site, not at import time, so scripts that
// don't need the API key (e.g. ASR-only runs) don't fail on a missing key.
export interface Env {
  anthropicApiKey: string;
  model: string;
  catalogModel: string;
  whisperModel: string;
  python: string;
}

function resolvePython(): string {
  if (process.env.VIDEOSCAN_PYTHON) return process.env.VIDEOSCAN_PYTHON;
  const venv = resolve(process.cwd(), "python/.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

export function env(): Env {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return {
    anthropicApiKey,
    model: process.env.VIDEOSCAN_MODEL ?? "claude-opus-5",
    catalogModel: process.env.VIDEOSCAN_CATALOG_MODEL ?? "claude-sonnet-5",
    whisperModel: process.env.VIDEOSCAN_WHISPER_MODEL ?? "large-v3",
    python: resolvePython(),
  };
}

// Subset that doesn't require the API key — for Layer 3 (ASR) standalone use.
export function asrEnv(): Pick<Env, "whisperModel" | "python"> {
  return {
    whisperModel: process.env.VIDEOSCAN_WHISPER_MODEL ?? "large-v3",
    python: resolvePython(),
  };
}
