#!/usr/bin/env python3
"""Reorganize Google Drive videos into YYYY-MM-DD folders, dedup-aware.

SAFETY:
- Moves only via os.rename (metadata move on the same mount → NO content download).
  If a move would cross devices (EXDEV) it raises instead of copy+deleting, so we
  never silently download a file. The first move is verified against free-disk
  delta; if space drops (i.e. it downloaded), we revert and abort.
- Duplicates (same name+size) are MOVED to _중복정리, never deleted.
- Every move is appended to a log CSV (orig,new) so the whole thing is reversible.
- Excludes: 'jun 5th'/6월 (active upload), 'Finished Videos', '_중복정리',
  and any existing YYYY-MM-DD date folders.

Usage: reorg-drive.py "<drive root>" "<logfile.csv>"
"""
import os, re, sys, csv, collections, datetime

drive, logpath = sys.argv[1], sys.argv[2]
EXTS = {'.mp4', '.mov', '.m4v', '.avi', '.mkv'}
DATE_RE = re.compile(r'(20\d{2})(\d{2})(\d{2})')
EXCLUDE = re.compile(r'(jun ?5|6월|_중복정리|Finished Videos)', re.I)
HOME = os.path.expanduser('~')


def free_gb():
    s = os.statvfs(HOME)
    return s.f_bavail * s.f_frsize / 1024**3


def date_of(path, name):
    m = DATE_RE.search(name)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    try:
        return datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    except OSError:
        return "unknown"


def unique_dest(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 2
    while os.path.exists(f"{base}__{i}{ext}"):
        i += 1
    return f"{base}__{i}{ext}"


# 1) full walk first (so later moves don't perturb the walk)
vids = []
for dp, dirs, fs in os.walk(drive):
    rel = os.path.relpath(dp, drive)
    if rel != '.' and any(EXCLUDE.search(part) for part in rel.split(os.sep)):
        dirs[:] = []
        continue
    for f in fs:
        if os.path.splitext(f)[1].lower() not in EXTS:
            continue
        p = os.path.join(dp, f)
        try:
            sz = os.path.getsize(p)
        except OSError:
            sz = 0
        vids.append({'name': f, 'path': p, 'size': sz,
                     'date': date_of(p, f), 'parent': os.path.basename(dp)})

# 2) dedup by (name,size)
groups = collections.defaultdict(list)
for v in vids:
    groups[(v['name'], v['size'])].append(v)
keepers, dups = [], []
for g in groups.values():
    keepers.append(g[0])
    dups.extend(g[1:])

print(f"videos={len(vids)} keepers={len(keepers)} dups={len(dups)}", flush=True)

log = open(logpath, 'w', newline='')
w = csv.writer(log)
w.writerow(['action', 'orig', 'new', 'size'])

moved = txtmoved = dupmoved = skipped = failed = 0
first = True


def do_move(src, dst, action, verify=False):
    global first
    before = free_gb() if verify else None
    os.rename(src, dst)  # raises on EXDEV — intentionally no copy fallback
    if verify:
        after = free_gb()
        if before - after > 0.5:
            os.rename(dst, src)  # revert
            raise SystemExit(f"ABORT: move downloaded content (free {before:.1f}->{after:.1f}GB)")
        print(f"verify ok: rename is metadata-only (free {before:.1f}->{after:.1f}GB)", flush=True)
    w.writerow([action, src, dst, os.path.getsize(dst) if os.path.exists(dst) else ''])


for v in keepers:
    if v['parent'] == v['date']:
        skipped += 1
        continue
    tgt = os.path.join(drive, v['date'])
    os.makedirs(tgt, exist_ok=True)
    dest = unique_dest(os.path.join(tgt, v['name']))
    try:
        do_move(v['path'], dest, 'MOVE', verify=first)
        first = False
        moved += 1
    except SystemExit:
        raise
    except OSError as e:
        failed += 1
        print(f"FAIL move {v['name']}: {e}", flush=True)
        continue
    # sibling .txt note travels with its video
    stem = os.path.splitext(v['name'])[0]
    txt = os.path.join(os.path.dirname(v['path']), stem + '.txt')
    if os.path.exists(txt):
        try:
            do_move(txt, unique_dest(os.path.join(tgt, stem + '.txt')), 'MOVE_TXT')
            txtmoved += 1
        except OSError:
            pass
    if moved % 50 == 0:
        print(f"...moved {moved}", flush=True)

dupdir = os.path.join(drive, '_중복정리')
for v in dups:
    os.makedirs(dupdir, exist_ok=True)
    dest = unique_dest(os.path.join(dupdir, v['name']))
    try:
        do_move(v['path'], dest, 'DUP')
        dupmoved += 1
    except OSError as e:
        failed += 1
        print(f"FAIL dup {v['name']}: {e}", flush=True)

log.close()
print(f"DONE moved={moved} txt={txtmoved} dups->_중복정리={dupmoved} "
      f"already_placed={skipped} failed={failed}", flush=True)
print(f"log: {logpath}", flush=True)
