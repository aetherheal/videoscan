#!/usr/bin/env python3
"""Part A: move root YYYY-MM-DD folders under Recordings/.
Part B: move photos (JPG) co-located with videos + ALL LRF proxies into the
        matching Recordings/<date>/ folder, by each file's own date.

- Metadata-only os.rename (no download); first move verified on free-disk delta.
- "Co-located with a video" for JPGs = the file's parent folder previously held a
  moved video (read from the reorg move-log). Standalone photo folders (e.g.
  'Tune interior pictures') are therefore left alone. All LRF are moved (they are
  always camera proxies paired with a video).
- Exact duplicates (same name+size) → _중복정리; same-name-different-size → suffixed.
- Excludes jun 5th / 6월, _중복정리, Finished Videos, and already-dated folders.

Usage: move-into-recordings.py "<drive>" "<reorg-log.csv>" "<out-log.csv>" [--apply]
"""
import os, re, sys, csv, collections, datetime

drive, reorglog, outlog = sys.argv[1], sys.argv[2], sys.argv[3]
apply = "--apply" in sys.argv[4:]
REC = os.path.join(drive, "Recordings")
DUP = os.path.join(drive, "_중복정리")
DATEFOLDER = re.compile(r'^20\d{2}-\d{2}-\d{2}$')
DATE_RE = re.compile(r'(20\d{2})(\d{2})(\d{2})')
EXCLUDE = re.compile(r'(jun ?5|6월|_중복정리|Finished Videos)', re.I)
HOME = os.path.expanduser('~')


def free_gb():
    s = os.statvfs(HOME)
    return s.f_bavail * s.f_frsize / 1024**3


def date_of(p, f):
    m = DATE_RE.search(f)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    try:
        return datetime.date.fromtimestamp(os.path.getmtime(p)).isoformat()
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


log = open(outlog, 'w', newline='')
w = csv.writer(log)
w.writerow(['action', 'orig', 'new'])
verified = [False]


def move(src, dst, action):
    before = None if verified[0] else free_gb()
    os.rename(src, dst)
    if not verified[0]:
        after = free_gb()
        if before - after > 0.5:
            os.rename(dst, src)
            raise SystemExit(f"ABORT: download detected (free {before:.1f}->{after:.1f}GB)")
        print(f"verify ok: metadata move (free {before:.1f}->{after:.1f}GB)", flush=True)
        verified[0] = True
    w.writerow([action, src, dst])


# ---- PART A: root date folders -> Recordings/ ----
a_moved = 0
for name in sorted(os.listdir(drive)):
    if not DATEFOLDER.match(name):
        continue
    src = os.path.join(drive, name)
    if not os.path.isdir(src):
        continue
    dst = os.path.join(REC, name)
    if os.path.exists(dst):  # merge into existing
        for f in os.listdir(src):
            if apply:
                move(os.path.join(src, f), unique_dest(os.path.join(dst, f)), 'A_MERGE')
        if apply:
            try: os.rmdir(src)
            except OSError: pass
    else:
        if apply:
            move(src, dst, 'A_FOLDER')
    a_moved += 1

# ---- PART B: co-located JPG + all LRF -> Recordings/<date>/ ----
had_video_dirs = set()
with open(reorglog) as fh:
    for row in csv.DictReader(fh):
        had_video_dirs.add(os.path.dirname(row['orig']))

cands = []  # (name, path, size, date, kind)
for dp, dirs, fs in os.walk(drive):
    rel = os.path.relpath(dp, drive)
    parts = rel.split(os.sep)
    if rel != '.' and (any(EXCLUDE.search(p) for p in parts) or any(DATEFOLDER.match(p) for p in parts)):
        dirs[:] = []
        continue
    for f in fs:
        ext = os.path.splitext(f)[1].lower()
        if ext == '.lrf':
            kind = 'LRF'
        elif ext in ('.jpg', '.jpeg'):
            if dp not in had_video_dirs:
                continue  # standalone photo, not with a video
            kind = 'JPG'
        else:
            continue
        p = os.path.join(dp, f)
        try: sz = os.path.getsize(p)
        except OSError: sz = 0
        cands.append((f, p, sz, date_of(p, f), kind))

groups = collections.defaultdict(list)
for c in cands:
    groups[(c[0], c[2])].append(c)
keepers = [g[0] for g in groups.values()]
dups = [x for g in groups.values() for x in g[1:]]

b_moved = collections.Counter()
b_dup = 0
print(f"PART A: {a_moved} date folders -> Recordings/", flush=True)
print(f"PART B: cands JPG/LRF={len(cands)}  keepers={len(keepers)} dups={len(dups)}", flush=True)
print(f"  by kind: " + ", ".join(f"{k}={sum(1 for c in keepers if c[4]==k)}" for k in ('LRF','JPG')), flush=True)

if apply:
    for f, p, sz, d, kind in keepers:
        tgt = os.path.join(REC, d)
        os.makedirs(tgt, exist_ok=True)
        try:
            move(p, unique_dest(os.path.join(tgt, f)), f'B_{kind}')
            b_moved[kind] += 1
        except OSError as e:
            print(f"FAIL {f}: {e}", flush=True)
    for f, p, sz, d, kind in dups:
        os.makedirs(DUP, exist_ok=True)
        try:
            move(p, unique_dest(os.path.join(DUP, f)), f'B_DUP_{kind}')
            b_dup += 1
        except OSError as e:
            print(f"FAIL dup {f}: {e}", flush=True)
    print(f"DONE A={a_moved} B_moved={dict(b_moved)} B_dups->_중복정리={b_dup}", flush=True)

log.close()
print(f"{'log: '+outlog if apply else '(dry-run, no changes)'}", flush=True)
