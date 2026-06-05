#!/usr/bin/env python3
"""Delete files in _중복정리 ONLY when a surviving twin (same name+size) exists
elsewhere in the Drive. Anything without a twin is kept and flagged.

- Twin match normalizes the "__N" collision suffix we may have added on move,
  so 'foo__2.MP4' matches a surviving 'foo.MP4'.
- Deletion goes to Google Drive trash (recoverable ~30 days).
- Dry-run by default; --apply deletes (only if every file has a twin, unless
  --force).

Usage: purge-duplicates.py "<drive>" "<delete-log.csv>" [--apply] [--force]
"""
import os, re, sys, csv, collections

drive, dellog = sys.argv[1], sys.argv[2]
apply = "--apply" in sys.argv[3:]
force = "--force" in sys.argv[3:]
DUPDIR = os.path.join(drive, "_중복정리")
SUFFIX = re.compile(r'__\d+(?=\.[^.]+$)')


def norm(name):
    return SUFFIX.sub('', name)


# index every file OUTSIDE _중복정리 by (normalized name, size)
outside = collections.Counter()
for dp, dirs, fs in os.walk(drive):
    if os.path.abspath(dp).startswith(os.path.abspath(DUPDIR)):
        dirs[:] = []
        continue
    for f in fs:
        try: sz = os.path.getsize(os.path.join(dp, f))
        except OSError: continue
        outside[(norm(f), sz)] += 1

safe, orphan = [], []
for dp, _, fs in os.walk(DUPDIR):
    for f in fs:
        if f == '.DS_Store':
            continue
        p = os.path.join(dp, f)
        try: sz = os.path.getsize(p)
        except OSError: continue
        (safe if outside.get((norm(f), sz), 0) > 0 else orphan).append((f, p, sz))

print(f"_중복정리 files: {len(safe)+len(orphan)}")
print(f"  twin exists (safe to delete): {len(safe)}")
print(f"  NO twin (will KEEP, flagged):  {len(orphan)}")
for f, p, sz in orphan[:30]:
    print(f"    KEEP  {os.path.relpath(p, drive)}  ({sz/1024**2:.0f}MB)")

if apply:
    if orphan and not force:
        print("\nNOT deleting: some files have no surviving twin. Re-run with --force "
              "to delete only the safe ones, or review the KEEP list above.")
        sys.exit(1)
    with open(dellog, 'w', newline='') as fh:
        w = csv.writer(fh); w.writerow(['deleted_path', 'size'])
        n = 0
        for f, p, sz in safe:
            try:
                os.remove(p)
                w.writerow([p, sz]); n += 1
            except OSError as e:
                print(f"FAIL delete {f}: {e}")
        print(f"\nDELETED {n} duplicates (→ Drive trash). log: {dellog}")
else:
    print("\n(dry-run, nothing deleted)")
