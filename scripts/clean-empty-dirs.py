#!/usr/bin/env python3
"""Remove empty folders (no real files anywhere beneath) under a Drive root.

- Deepest-first, so a parent that becomes empty after its children are removed is
  also removed. A folder containing only .DS_Store counts as empty (the .DS_Store
  is deleted with it).
- Protects the 'jun 5th' / '6월' branch (active upload) — never touched.
- Dry-run by default; pass --apply to actually delete.

Usage: clean-empty-dirs.py "<drive root>" [--apply]
"""
import os, re, sys

root = sys.argv[1]
apply = "--apply" in sys.argv[2:]
PROTECT = re.compile(r'(jun ?5|6월)', re.I)

alldirs = []
for dp, dirs, fs in os.walk(root):
    alldirs.append(dp)
alldirs.sort(key=lambda p: p.count(os.sep), reverse=True)  # deepest first

candidates = []
removed = set()  # track removed dirs so parents that become empty also qualify
for d in alldirs:
    if os.path.abspath(d) == os.path.abspath(root):
        continue
    rel = os.path.relpath(d, root)
    if any(PROTECT.search(part) for part in rel.split(os.sep)):
        continue
    try:
        entries = os.listdir(d)
    except OSError:
        continue
    # an entry still "counts" unless it's .DS_Store or an already-removed subdir
    present = [e for e in entries
               if e != '.DS_Store' and os.path.join(d, e) not in removed]
    if present:
        continue  # has real content
    candidates.append(d)
    removed.add(d)
    if apply:
        try:
            ds = os.path.join(d, '.DS_Store')
            if os.path.exists(ds):
                os.remove(ds)
            os.rmdir(d)
        except OSError as e:
            print(f"FAIL rmdir {rel}: {e}", flush=True)
            candidates.pop()
            removed.discard(d)

print(f"{'REMOVED' if apply else 'WOULD REMOVE'}: {len(candidates)} empty folders\n")
for d in sorted(candidates):
    print("  " + os.path.relpath(d, root))
