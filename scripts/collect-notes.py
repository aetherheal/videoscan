#!/usr/bin/env python3
"""Gather transcript notes (.txt that sit next to a same-stem video) into one
Scripts folder, stamping each note with the video's location (folder + filename).

Only .txt files that have a sibling video <stem>.<vidext> in the same folder are
treated as notes — so unrelated .txt (captions, readmes) are left alone.

Usage: collect-notes.py "<drive>" "<scripts dir>" [--apply]
"""
import os, sys, shutil

drive, scripts = sys.argv[1], sys.argv[2]
apply = "--apply" in sys.argv[3:]
VID = {'.mp4', '.mov', '.m4v', '.avi', '.mkv'}


def unique_dest(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 2
    while os.path.exists(f"{base}__{i}{ext}"):
        i += 1
    return f"{base}__{i}{ext}"


notes = []
for dp, dirs, fs in os.walk(drive):
    if os.path.abspath(dp).startswith(os.path.abspath(scripts)):
        dirs[:] = []
        continue
    names = set(fs)
    for f in fs:
        if not f.lower().endswith('.txt'):
            continue
        stem = os.path.splitext(f)[0]
        sib = next((stem + e for e in VID if (stem + e) in names
                    or (stem + e.upper()) in names), None)
        if not sib:
            continue
        notes.append((os.path.join(dp, f), os.path.join(dp, sib),
                      os.path.relpath(os.path.join(dp, sib), drive)))

print(f"{'MOVING' if apply else 'WOULD MOVE'} {len(notes)} notes -> Recordings/Scripts/")
for txt, vidpath, loc in notes:
    print("  " + os.path.relpath(txt, drive) + "   (video: " + loc + ")")
    if not apply:
        continue
    body = open(txt, encoding='utf-8').read()
    if not body.startswith("VIDEO FILE:"):
        body = f"VIDEO FILE: {loc}\n\n{body}"
    dest = unique_dest(os.path.join(scripts, os.path.basename(txt)))
    with open(dest, 'w', encoding='utf-8') as fh:
        fh.write(body)
    os.remove(txt)
if apply:
    print(f"\nDONE: {len(notes)} notes now in {os.path.relpath(scripts, drive)}/")
