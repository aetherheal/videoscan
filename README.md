# Videoscan AI

Automated **viral-shorts pipeline** for 압구정튠의원 (Apgujeong Tune Clinic),
operating under the **Chamakase (차마카세)** identity. It scans a long-form source
video and produces a ranked set of vertical (9:16) short-form clips engineered to
be watched to the end and shared.

It is **TypeScript orchestrator + Python ASR**: the layers are coordinated in
TypeScript; speech recognition runs as a Python (`faster-whisper`) subprocess;
model calls use either the Anthropic API (the default) or the locally
authenticated Codex CLI; rendering shells out to `ffmpeg`.

## Pipeline layers

```
source video
   │
   ▼  Layer 3 — ASR (python/asr.py, faster-whisper, word-level timestamps)
transcript.json
   │
   ▼  Layer 4 — editorial judgment (Claude, prompts/layer4-system.txt)
manifest.json  ── ranked ClipSpec[] (the build manifest)
   │
   ▼  Layer 5 — render (ffmpeg: cut → 9:16 crop → caption burn-in)
outputs/<video>/*.mp4   (+ a human-review queue for flagged clips)
```

Layer 4 is the intelligence of the pipeline. It judges **from text only**, so it
is blind to strong-visual / low-talk moments and flags those for manual review.
The full editorial spec lives in [`docs/layer4-editorial-judgment.md`](docs/layer4-editorial-judgment.md);
the paste-ready system prompt it consumes is [`prompts/layer4-system.txt`](prompts/layer4-system.txt).

## Setup

```bash
# Node deps
pnpm install            # (or npm install)

# Model provider (this repo reads process.env directly; it does not load .env)
# Default: set ANTHROPIC_API_KEY and leave VIDEOSCAN_PROVIDER unset/anthropic.
# ChatGPT subscription path: set VIDEOSCAN_PROVIDER=codex; no OPENAI_API_KEY.

# Python ASR (Layer 3)
python3 -m venv python/.venv
python/.venv/bin/pip install -r python/requirements.txt

# ffmpeg must be on PATH (decoding + rendering)
brew install ffmpeg
```

## Run

```bash
# Full scan: ASR → judge → render
pnpm scan inputs/my-video.mp4

# Dry run: ASR + Claude judgment run for real, but ffmpeg is skipped
pnpm scan:dry inputs/my-video.mp4

# Individual layers
pnpm asr    inputs/my-video.mp4            > transcript.json
pnpm judge  transcript.json                > manifest.json
pnpm render manifest.json inputs/my-video.mp4

pnpm typecheck
```

## Transcribe + summarize (notes)

Drop videos in a folder (including a Google Drive stream mount) and get a
`<name>.txt` next to each — an **English** summary + English translation +
verbatim original transcript. Built for "staff shoot anything, AI writes it
down."

```bash
# One video → writes <name>.txt beside it
pnpm note "/path/to/video.mp4"

# Whole folder, resumable (skips files that already have a .txt)
pnpm note:folder "/path/to/folder"

# Useful flags
pnpm note:folder "<folder>" --limit 5          # only the first 5 pending
pnpm note:folder "<folder>" --only DJI_2026     # filename substring filter
pnpm note:folder "<folder>" --overwrite         # redo existing notes
```

**Disk-safe mode (on by default).** Drive stream files must download locally to
be read, and a big folder can exceed your free disk. So each file is gated on
free space, transcribed from a small extracted-audio temp (deleted after), and
the Drive original is never touched. Tune it:

```bash
pnpm note:folder "<folder>" --min-free-gb 8     # keep ≥8GB free (default 5)
pnpm note:folder "<folder>" --max-file-gb 10    # defer files larger than 10GB
pnpm note:folder "<folder>" --no-disk-safe      # transcribe video in place
```

Files that don't fit the free-space budget are **deferred** (logged, not failed),
so the batch keeps going and you can re-run later when space frees up.

Outputs land in `outputs/<video-stem>/`:
`transcript.json`, `manifest.json`, and the rendered `*.mp4` clips. Clips with
`brand_safety: "review"` or `reframe_advice: "manual-review"` are **not**
auto-rendered — they are routed to the human queue (logged, left in the manifest).

## PD Select Pack (Mac + Premiere)

Turn the rolled-up catalog and viral-short manifests into a folder an editor can
use without a CLI, API key, or local runtime. It contains a double-clickable
search/review page, small preview proxies, and Premiere-importable FCP7 XML
select reels.

```powershell
pnpm review:pack `
  --source-root "F:\Tune Clinic Recordings" `
  --media-root "/Users/pd/Library/CloudStorage/GoogleDrive-Tune/Recordings" `
  --out "F:\Tune Clinic Recordings\AI Review" `
  --query "원장님 상담 설명" `
  --query "외관 드론 해질녘"
```

`--source-root` is the media mount on the build machine. `--media-root` is the
matching root on the editor's Mac; the generated XML embeds that Mac path while
ffprobe reads the Windows source. Send the complete output folder and have the
PD open `OPEN_ME.html`, then import the desired `.xml` file in Premiere.

See [`docs/pd-select-pack.md`](docs/pd-select-pack.md) for filters, review export,
path-mapping rules, and the one-time Premiere acceptance check.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VIDEOSCAN_PROVIDER` | `anthropic` | Model backend: `anthropic` (requires its API key) or `codex` (runs locally authenticated `codex exec`, so no OpenAI API key is needed). |
| `ANTHROPIC_API_KEY` | — | Anthropic access, required only when `VIDEOSCAN_PROVIDER=anthropic`. |
| `VIDEOSCAN_MODEL` | `claude-opus-5` | Layer 4 judge + notes summarizer model. Set `claude-sonnet-5` for the cost-optimized cron path; pre-4.6 models reject adaptive thinking / `effort`. |
| `VIDEOSCAN_CATALOG_MODEL` | `claude-sonnet-5` | High-volume footage catalog model. |
| `VIDEOSCAN_CODEX_MODEL` | `gpt-5.6-sol` | Codex CLI model for every model call when `VIDEOSCAN_PROVIDER=codex`. |
| `VIDEOSCAN_CODEX_TIMEOUT_MS` | `900000` | Codex CLI timeout per request (15 minutes by default; useful for vision over many keyframes). On timeout the process tree is killed. Transient failures (capacity, rate limit, 5xx) are retried 3x with 30s/2m/5m backoff. Calls pin `model_reasoning_effort=medium` rather than inheriting `~/.codex/config.toml`. |
| `VIDEOSCAN_WHISPER_MODEL` | `large-v3` | Layer 3 ASR model |
| `VIDEOSCAN_PYTHON` | venv or `python3` | Interpreter with `faster-whisper` |

## Status / TODO

This is a working scaffold. Before treating it as production:

- **Speaker-centered crop** — Layer 5 currently does a centered 9:16 cover crop.
  Wire a face/speaker detector for true reframing.
- **Caption burn-in** — `captions[]` is in the manifest but not yet drawn onto
  the video. Add a `drawtext`/ASS subtitle pass in Layer 5.
- **Scene-energy pass** — pair Layer 4 with the cheap audio-RMS + scene-change
  pass described in the spec's TUNING NOTES to surface high-visual/low-talk
  moments Layer 4 cannot see.
- **Threshold calibration** — recalibrate the virality threshold after the first
  2–3 weeks of human accept/reject data.
