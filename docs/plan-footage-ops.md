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
VIDEOSCAN_MODEL=claude-opus-5            # Layer 4 judge + notes summarizer
VIDEOSCAN_CATALOG_MODEL=claude-sonnet-5  # high-volume vision catalog
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

### B. Model migration → Sonnet 5 / Opus 5 — **DONE 2026-08-31**

Shipped. What landed, so you don't re-derive it:

- **The model is now split per layer**, via two env vars:

  | Layer | Env var | Default | Why |
  |---|---|---|---|
  | Layer 4 judge (`src/claude/client.ts`) + notes summarizer (`src/notes/summarize.ts`) | `VIDEOSCAN_MODEL` | `claude-opus-5` | CLAUDE.md calls this "the product"; 의료법 §56 compliance judgment rides on it. |
  | Catalog (`src/index/`) | `VIDEOSCAN_CATALOG_MODEL` | `claude-sonnet-5` | High-volume vision tagging over hundreds of clips; recognition, not deep judgment. Opus is overkill and multiplies cost. |

  Note `VIDEOSCAN_MODEL` drives the notes summarizer too, not just Layer 4.

- **`budget_tokens` is gone everywhere.** It is *removed* on 5-series models and
  returns HTTP 400. All three call sites now send `thinking: { type: "adaptive" }`
  with `output_config: { effort: "medium" }`. `effort` is the supported lever for
  the old spiral problem (adaptive thinking burning the whole budget and returning
  no text, `stop_reason=max_tokens`) — raise it only if output quality drops.
  Every call site also has an empty-text guard that surfaces `stop_reason`.

- **Any override must be a 4.6-or-newer model.** Pre-4.6 models (e.g.
  `claude-haiku-4-5`) reject both adaptive thinking and `effort`. The old docs
  advertised haiku-4-5 as the cheap cron path; that advice is now wrong and has
  been removed. Use `claude-sonnet-5` to run cheaper.

- **`max_tokens`** is 42000 (client.ts) / 10400 (catalog.ts) / 32000
  (summarize.ts). These are ceilings, not spend.

- **Keyframe resolution was the real lever, and it was the actual bottleneck.**
  The original rationale for Sonnet 5 was its 2576 px vision (vs 1568 px on 4.6) —
  but `src/index/keyframes.ts` was downscaling every keyframe to **768 px**, so
  none of that resolution ever reached the model. Now a named
  `KEYFRAME_LONG_EDGE = 1568` constant. Going to the full 2576 would roughly 11x
  the token bill of the old 768 across a 650-clip library for detail that
  scene-level recognition doesn't need; raise it only if the catalog must read
  on-screen text.

> **Env vars are not `.env`** — this repo reads `process.env` directly (§2). On
> Windows you must `setx VIDEOSCAN_MODEL claude-opus-5` (and
> `VIDEOSCAN_CATALOG_MODEL`) and open a new shell, or the migration is inert and
> you silently keep running whatever the old user env var says.

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
