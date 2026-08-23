# Project context for AI coding agents

## What this repo is

`videoscan` - the Video Scan viral-shorts pipeline for 압구정튠의원 (Apgujeong Tune Clinic),
under the **Chamakase (차마카세)** identity. It scans one long-form source video
and emits a ranked set of vertical (9:16) short clips.

**Architecture: TypeScript orchestrator + Python ASR.** Orchestration, judgment
call, and rendering are TypeScript (ESM, Node ≥ 20, `tsx` for scripts). Speech
recognition is a Python `faster-whisper` subprocess. Rendering shells out to
`ffmpeg`.

## The five layers

| Layer | Where | Does |
|---|---|---|
| 3 — ASR | `python/asr.py` ← `src/layers/layer3-asr.ts` | transcript + word timestamps |
| 4 — judgment | `src/claude/client.ts` ← `src/layers/layer4-judge.ts` | ranked `ClipSpec[]` via Claude |
| 5 — render | `src/layers/layer5-render.ts` | ffmpeg cut → 9:16 crop → (TODO captions) |

`src/pipeline/run.ts` wires 3 → 4 → 5. (Layers 1–2 — sourcing/ingest of the raw
video — are out of scope; drop files in `inputs/`.)

## Key files

- `prompts/layer4-system.txt` — the editorial-judgment system prompt. **This is
  the product.** Edit it to change clip selection behavior.
- `docs/layer4-editorial-judgment.md` — the full spec (input contract, output
  schema, tuning notes). Read it before touching Layer 4.
- `src/config/schema.ts` — zod schema for the `ClipSpec` manifest. The source of
  truth for the Layer 4 ↔ Layer 5 contract.
- `src/types.ts` — the `WhisperTranscript` shape (Layer 3 ↔ Layer 4 contract).

## Conventions

- **TypeScript strict**, ESM. Always use `.js` extensions in relative imports.
- **Claude calls**: use `@anthropic-ai/sdk`, model from `env()`, adaptive
  thinking. Default model is `claude-opus-4-8` (override via `VIDEOSCAN_MODEL`;
  `claude-haiku-4-5` is the cost-optimized cron option). Never hardcode the key.
- Layer 4 returns a **strict JSON array** — validate with `clipManifestSchema`,
  never trust raw model text.
- `src/layers/*` and `src/pipeline/*` own side effects (subprocesses, ffmpeg, fs).
  Keep `src/config/*` and `src/claude/client.ts` parsing/validation pure-ish.

## Safety / brand boundary

- Layer 4 **judges from text only** — it cannot see footage, so it flags
  visual-dependent segments as `manual-review`. Do not "fix" this by pretending
  it can see video.
- 의료법 §56 compliance: no guaranteed-result claims, superlatives, efficacy
  claims, or testimonials-as-proof. Layer 4 flags violations as
  `brand_safety: "review"` and **must not silently rewrite** a physician's
  clinical statement.
- Flagged clips (`brand_safety: "review"` OR `reframe_advice: "manual-review"`)
  are **never auto-rendered** — they go to the human queue. Keep it that way.

## Run / check

```bash
pnpm install
pnpm typecheck
pnpm scan:dry inputs/<video>.mp4   # ASR + judge, no ffmpeg
pnpm scan     inputs/<video>.mp4   # full
```
