# Plan — footage backup + catalog ops

Written 2026-08-22. Pick-up doc for continuing this work on another machine.
Read this top-to-bottom before touching code; §2 will bite you otherwise.

---

## 1. Where things stand

**Repo.** `github.com/aetherheal/videoscan`. It had been archived as
`aetherheal/zz-archived-videoscan` (the org's `zz-archived-` convention for dead
repos) and was unarchived + renamed back on 2026-08-22. Commit history and
issues survived intact. If you cloned before that date, your remote points at
the old redirect — re-point it:

```sh
git remote set-url origin https://github.com/aetherheal/videoscan.git
```

**Footage.** Drone SD card held 38 DJI clips (2026-08-15 → 08-22). The 17 that
existed on neither backup (~81 GB, shot 08-18 → 08-22) were copied on 2026-08-22
to both destinations, into date-named subfolders, verified 0 missing:

| Destination | Path | MP4 count after copy |
|---|---|---|
| External 4TB ("Dr. Ju", exFAT) | `F:\Tune Clinic Recordings` | 690 |
| Google Drive mount | `G:\.shortcut-targets-by-id\123pT05uNBW13LMY8drgCjx6jLU86d7Ia\Recordings` | 930 |

Measured throughput was ~27–33 MB/s per destination. `.LRF` proxy files are
deliberately not copied.

> **The SD card originals were NOT deleted.** They are still on the card. Decide
> deliberately before wiping it.

The G: copy is local-only — Google Drive's own background upload to the cloud is
separate and was not tracked.

---

## 2. Setting up on a new machine (do this first)

This repo was authored for macOS and has Windows-specific gotchas. Most of these
fail *silently*, which is what makes them expensive.

**The code never reads `.env`.** `src/config/env.ts:20` reads `process.env`
directly, despite `.env.example` existing. On Windows configure via user env vars
(`setx`), then open a new shell:

```
ANTHROPIC_API_KEY=<key>
VIDEOSCAN_MODEL=claude-sonnet-5          # see §3B before setting this
VIDEOSCAN_PYTHON=<repo>\python\.venv\Scripts\python.exe
VIDEOSCAN_WHISPER_MODEL=medium
PYTHONUTF8=1
```

- **`VIDEOSCAN_PYTHON` is required on Windows.** `resolvePython()`
  (`src/config/env.ts:15`) only probes the macOS venv path
  (`python/.venv/bin/python`); the Windows interpreter is at
  `python\.venv\Scripts\python.exe`, so without the override it silently falls
  back to whatever `python3` resolves to.
- **`PYTHONUTF8=1` is required for Korean.** Without it the Python ASR subprocess
  emits cp949 on stdout while the Node orchestrator decodes UTF-8, and every
  Korean transcript comes back as `��`. (Alternative fix, not taken:
  `ensure_ascii=True` in `python/asr.py`.)

**Toolchain:** Node ≥ 20 (24 used), ffmpeg, Python 3.12, pnpm.

**pnpm v11** blocks scripts because esbuild's build script is unapproved. Worked
around globally with `pnpm config set verify-deps-before-run false` — esbuild's
bundled binary is fine without it.

**Git identity is per-repo local config and does not travel.** A fresh clone will
have `user.name` unset. Set it before committing.

**Drive letters are machine-specific.** `D:` / `F:` / `G:` above are from the
original machine. Re-check with `Get-Volume` and never hardcode them (see §3C).

---

## 3. Work items

Ordered by value-per-effort. A is a handful of lines and unblocks the rest.

### A. Fix the Windows CLI entry guard — 4 files (do this first)

Four CLI entry points are dead on Windows. The guard

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
```

is **always false** on Windows, because `process.argv[1]` is a backslash path
(`C:\...`) while `import.meta.url` is a percent-encoded `file:///C:/...` URL. The
script exits 0 having done nothing — no error, no output.

Affected, with the pnpm script each one breaks:

| File:line | Dead command |
|---|---|
| `src/index/build-index.ts:83` | `pnpm index` |
| `src/layers/layer3-asr.ts:44` | `pnpm asr` |
| `src/layers/layer4-judge.ts:11` | `pnpm judge` |
| `src/layers/layer5-render.ts:83` | `pnpm render` |

The fix is already in this repo — `src/notes/*.ts` was migrated to it earlier and
those three commands work. Copy that form exactly:

```ts
import { pathToFileURL } from "node:url";
// ...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
```

`pnpm scan` / `scan:dry` are unaffected (`src/pipeline/run.ts` has no guard), which
is why they were the only things ever verified working on Windows.

### B. Model migration → Sonnet 5

Currently `VIDEOSCAN_MODEL=claude-sonnet-4-6` (previous-gen Sonnet); the code
default at `src/config/env.ts:28` is `claude-opus-4-8`.

**Why Sonnet 5 specifically matters here:** it is the first Sonnet-tier model with
high-resolution vision (2576 px long edge, vs 1568 px on Sonnet 4.6). The whole
catalog layer is keyframe understanding, so that is the load-bearing difference.
Sonnet 5 introductory pricing is $2/$10 per MTok vs the $3/$15 list rate —
**introductory pricing ends 2026-08-31.**

**Blocker — changing the env var alone will break Layer 4.**
`src/claude/client.ts:45` sends:

```ts
thinking: { type: "enabled", budget_tokens: 8000 },
```

`budget_tokens` is *removed* on Sonnet 5 and returns HTTP 400. It still works on
Sonnet 4.6 (deprecated), which is why nothing has failed yet. Replace with:

```ts
thinking: { type: "adaptive" },
output_config: { effort: "medium" },
```

Note the comment at `src/claude/client.ts:41-43`: adaptive thinking previously
spiralled on long transcripts, burning the whole budget and returning no text
(`stop_reason=max_tokens`), and `budget_tokens` was the workaround. **`effort` is
the supported lever for exactly that problem** — start at `medium` and only raise
it if clip quality drops.

`src/index/catalog.ts:107` already uses `thinking: { type: "adaptive" }` with no
`budget_tokens`, so the catalog layer needs no change.

Also re-check `max_tokens` after switching: Sonnet 5 uses a new tokenizer that
produces roughly 30% more tokens for the same text, so the `max_tokens: 32000` at
`client.ts:44` and `max_tokens: 8000` at `catalog.ts:106` have less real headroom
than they did on 4.6.

**Suggested split** rather than one global model — the two layers have different
shapes, so consider a second env var (e.g. `VIDEOSCAN_CATALOG_MODEL`):

| Layer | Model | Why |
|---|---|---|
| Catalog (`src/index/`) | `claude-sonnet-5` | High-volume vision tagging over hundreds of clips; recognition, not deep judgment. Opus is overkill and multiplies cost. |
| Layer 4 judge (`src/claude/client.ts`) | `claude-opus-5` | CLAUDE.md calls this "the product"; 의료법 §56 compliance judgment rides on it. |

### C. `backup.ps1` — generalize the SD-card copy

`scripts/sd_copy.ps1` is the one-off that ran the 2026-08-22 copy. It hardcodes
drive letters, the date→file mapping, and the destination paths. Generalize it
into a distributable tool:

- Derive the date folder from the DJI filename (`DJI_YYYYMMDDHHMMSS_NNNN_D.MP4`)
  instead of a hand-written map. This part is pure string parsing — **no AI
  needed, do not add an API call here.**
- Take source and destination roots as parameters / a config file, not literals.
- Diff against *both* destinations by filename before copying; skip `.LRF`.
- Keep it **zero-dependency PowerShell** — no Node, no API key, no network. That
  is the whole point: the moment it needs an API key it stops being something you
  can hand to someone else.
- Emit the list of newly-copied files (e.g. `--manifest out.json`) so the catalog
  run in §D can consume it and index only what is new.

Copy runs long; a background job writing a progress log worked well
(`robocopy /J /R:2 /W:5 /NP /LOG+:...`) — a foreground run will outlive most
shell timeouts.

### D. Run the catalog over the library

**The visual catalog already exists — do not rebuild it.** `pnpm index`
(`src/index/build-index.ts`) already does the full pipeline: optional ASR →
scene detect → keyframe extraction → Claude vision → `footage-index.json`, and
`src/index/catalog.ts` already emits per-scene `shot_type`, `setting`,
`description`, `people`, `is_b_roll`, `tags`, and `usable_for`. It has almost
certainly never run on Windows because of the §A bug.

Once §A is fixed:

1. Run `pnpm index` on a handful of clips and check `outputs/<stem>/footage-index.json`.
2. Use `--no-asr` for drone B-roll. Those clips are wind noise; ASR costs time and
   money for nothing, and the catalog layer judges primarily from the image anyway.
   Keep ASR on for interior / talking-head footage.
3. Then batch it over `F:\Tune Clinic Recordings`, driven by §C's manifest so
   re-runs skip already-indexed clips.

Two things worth building on top once indexes exist:

- **Junk detection.** The 2026-08-22 batch contained a 14.5 MB and an 89.7 MB clip
  — almost certainly accidental recordings. Duration + file size + the first
  keyframe is enough to flag deletion candidates. At ~81 GB per week of shooting
  this pays for itself.
- **Cross-video search.** The per-clip `footage-index.json` files need to roll up
  into one searchable index; "find the sunset drone shot" is the actual payoff
  and is the stated purpose of the catalog layer.

---

## 4. Open decisions

- **Wipe the SD card?** Originals are still on it; both backups verified.
- **Distribute `backup.ps1` where?** Options discussed: keep it in this repo, or
  split it into its own public repo since it's a standalone zero-dependency tool
  with no connection to the AI pipeline.
- **Split `VIDEOSCAN_MODEL` per layer** (§B) or keep one global model?
- **Google Drive cloud upload** for the 81 GB was never confirmed as finished —
  worth checking the Drive client on the original machine.
