# Videoscan AI

Automated **viral-shorts pipeline** for 압구정튠의원 (Apgujeong Tune Clinic),
operating under the **Chamakase (차마카세)** identity. It scans a long-form source
video and produces a ranked set of vertical (9:16) short-form clips engineered to
be watched to the end and shared.

It is **TypeScript orchestrator + Python ASR**: the layers are coordinated in
TypeScript; speech recognition runs as a Python (`faster-whisper`) subprocess;
the editorial judgment is a Claude API call; rendering shells out to `ffmpeg`.

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

# Secrets
cp .env.example .env    # then set ANTHROPIC_API_KEY

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

Outputs land in `outputs/<video-stem>/`:
`transcript.json`, `manifest.json`, and the rendered `*.mp4` clips. Clips with
`brand_safety: "review"` or `reframe_advice: "manual-review"` are **not**
auto-rendered — they are routed to the human queue (logged, left in the manifest).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Layer 4 Claude access (required) |
| `VIDEOSCAN_MODEL` | `claude-opus-4-8` | Layer 4 model. Set `claude-haiku-4-5` for the cost-optimized cron path. |
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
