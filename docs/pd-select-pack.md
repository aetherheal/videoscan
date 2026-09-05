# PD Select Pack

`review:pack` turns the existing footage catalog and viral-short manifests into
a folder an editor can open without Node, Python, an API key, or a terminal.
The pack contains local preview proxies, a searchable `OPEN_ME.html`, saved
review-state export, and one Premiere-importable FCP7 XML select reel per group.

## Build on the indexing machine

The source root is the media path on the machine running Videoscan. The media
root is the equivalent root on the editor's Mac. Their folder structure below
the root must match.

```powershell
pnpm review:pack `
  --source-root "F:\Tune Clinic Recordings" `
  --media-root "/Users/pd/Library/CloudStorage/GoogleDrive-Tune/Recordings" `
  --catalog "outputs\footage-catalog.json" `
  --shorts-root "outputs\scan-state" `
  --out "F:\Tune Clinic Recordings\AI Review" `
  --query "원장님 상담 설명" `
  --query "외관 드론 해질녘"
```

`--query` is repeatable and produces a separate Premiere select reel for each
search. With no query, the pack contains the first `--max-scenes` catalog scenes
under the selected source root. Viral manifests are included automatically when
their media resolves under that root.

Useful controls:

| Flag | Default | Effect |
|---|---:|---|
| `--limit N` | 20 | Results per query after filtering to this media root |
| `--max-scenes N` | 50 | Maximum non-viral scene cards across the pack |
| `--viral-limit N` | 20 | Highest-scoring viral candidates |
| `--proxy-height N` | 360 | Review proxy height |
| `--no-proxies` | off | Build metadata/XML only |
| `--no-xml` | off | Build HTML/proxies only |

The command performs no model calls. Re-running it reuses proxy files whose
source-relative path and time range have not changed.

An offline Google Drive placeholder or damaged movie does not abort the whole
pack. Its HTML card is retained with `원본 읽기 실패`, its proxy/XML entry is
skipped, and the remaining candidates continue. The build log keeps the full
ffmpeg diagnostic while the portable pack stores only the relative media path.

## Hand off to the PD

Copy or sync the complete output folder. The PD then:

1. Double-clicks `OPEN_ME.html` and reviews the local proxies.
2. Marks candidates **채택**, **보류**, or **제외**, adding notes when useful.
3. Clicks **검토 결과 저장** to download `pd-review.json`.
4. Imports the desired `.xml` file using Premiere's **File > Import**.

The HTML stores in-progress decisions in that browser's local storage. Export
the JSON before moving to another machine or rebuilding browser data.

## Media relinking contract

The generated HTML and `pack-data.json` never contain the build machine's local
absolute paths. Each item stores a slash-separated path relative to
`--source-root` plus the matching Mac path below `--media-root`. The XML is
probed against the local Windows file but embeds only the Mac `target_path`.

If Premiere cannot link media, verify the Mac root once and regenerate the pack.
Do not solve this by matching only on basename: cameras commonly reuse names,
and Videoscan deliberately reports duplicate basenames as ambiguous instead of
silently connecting the wrong shoot.

## Acceptance check on the PD Mac

Automated tests validate proxy playback files, portable paths, XML well-formedness,
special-character escaping, and mixed-root separation. A real Premiere install
is still the final physical-device check:

1. Import one generated XML.
2. Confirm picture and linked stereo audio appear on the sequence.
3. Confirm the first and last edit points match the HTML timecodes.
4. Move/rename the Windows source root out of reach and confirm the XML still
   references only the configured Mac media root.
