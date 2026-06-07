#!/usr/bin/env python3
"""Restore footage from the company Google Drive back onto the (reformatted) exFAT
external drive, mirroring Recordings/<date>/ structure.

Reality: Drive files are online-only placeholders; copying one downloads it into
Drive's local cache on the Mac STARTUP disk, then writes to the external. So each
file transiently needs ~its own size free on the startup disk. With little free
space this is the bottleneck, so:
- smallest-first, resumable (skip files already on the external with same size),
- free-space gate: before each file, wait for Drive to evict cache until there's
  room; files too big to ever fit (size > maxfree-margin) are DEFERRED + listed,
- " copy" duplicate artifacts are skipped,
- every copy logged for verification.

Usage: restore-to-drive.py "<drive>" "<dest root>" [--apply] [--min-free-gb N]
"""
import os, sys, time, csv, shutil, re

drive, dest_root = sys.argv[1], sys.argv[2]
apply = "--apply" in sys.argv[3:]
min_free = 6.0
if "--min-free-gb" in sys.argv:
    min_free = float(sys.argv[sys.argv.index("--min-free-gb") + 1])
SRC = os.path.join(drive, "Recordings")
DEST = os.path.join(dest_root, "Tune Clinic Recordings")
EXTS = {'.mp4', '.mov', '.m4v', '.avi', '.mkv'}
HOME = os.path.expanduser('~')
COPY_DUP = re.compile(r' copy(\.[^.]+)?$', re.I)
WAIT_STEP, WAIT_MAX = 15, 600


def free_gb():
    s = os.statvfs(HOME)
    return s.f_bavail * s.f_frsize / 1024**3


cands = []
for dp, dirs, fs in os.walk(SRC):
    if any(p in dp for p in ('jun 5th', '6월')):
        dirs[:] = []
        continue
    for f in fs:
        if os.path.splitext(f)[1].lower() not in EXTS:
            continue
        stem = os.path.splitext(f)[0]
        if COPY_DUP.search(stem):
            continue  # duplicate artifact
        p = os.path.join(dp, f)
        try: sz = os.path.getsize(p)
        except OSError: sz = 0
        cands.append((sz, p, os.path.relpath(p, SRC)))
cands.sort()  # smallest first

total = sum(s for s, _, _ in cands)
print(f"복구 대상: {len(cands)} videos, {total/1024**3:.1f} GB -> {DEST}", flush=True)
print(f"현재 startup 여유: {free_gb():.1f}GB, min-free margin: {min_free}GB\n", flush=True)
if not apply:
    big = [(s, r) for s, _, r in cands if s/1024**3 > free_gb() - min_free]
    print(f"(dry-run) 지금 여유로 바로 못 받는 큰 파일(보류 예상): {len(big)}")
    for s, r in sorted(big, reverse=True)[:10]:
        print(f"    {s/1024**3:.1f}GB  {r}")
    sys.exit(0)

log = open(os.path.join(os.path.dirname(__file__), "..", "outputs", "restore-log.csv"), "w", newline="")
w = csv.writer(log); w.writerow(["status", "rel", "size", "dest"])
copied = skipped = deferred = failed = 0
for sz, src, rel in cands:
    dest = os.path.join(DEST, rel)
    if os.path.exists(dest) and abs(os.path.getsize(dest) - sz) < 1024:
        skipped += 1
        continue
    need = sz/1024**3 + min_free
    waited = 0
    while free_gb() < need:
        if waited >= WAIT_MAX:
            break
        time.sleep(WAIT_STEP); waited += WAIT_STEP
    if free_gb() < need:
        deferred += 1
        w.writerow(["DEFERRED_TOOBIG", rel, sz, ""])
        print(f"  ⏸ defer {rel} ({sz/1024**3:.1f}GB) — startup 여유 부족({free_gb():.1f}GB)", flush=True)
        continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        shutil.copy2(src, dest)
        if abs(os.path.getsize(dest) - sz) >= 1024:
            raise IOError("size mismatch after copy")
        copied += 1
        w.writerow(["COPIED", rel, sz, dest])
        if copied % 20 == 0:
            print(f"  ...{copied} copied, free {free_gb():.1f}GB", flush=True)
    except Exception as e:
        failed += 1
        w.writerow(["FAILED", rel, sz, str(e)])
        print(f"  ✗ {rel}: {e}", flush=True)
log.close()
print(f"\nDONE copied={copied} skipped_existing={skipped} deferred_big={deferred} failed={failed}", flush=True)
print("deferred(너무 큰) 파일은 Mac 여유공간 늘린 뒤 재실행하거나 Windows에서 복사하세요.", flush=True)
