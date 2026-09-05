#!/usr/bin/env python3
"""Generate a Premiere-importable FCP7 XML (xmeml v4) timeline from an edit list.

Edit list JSON:
  {"name": "My Cut", "clips": [{"path": "/abs/clip.mp4", "target_path":
  "/Volumes/shared/clip.mp4", "in": 0.0, "out": 7.6}, ...]}
in/out are seconds into each source. Clips are laid end-to-end on V1/A1/A2.

``path`` is the locally mounted file used by ffprobe. Optional ``target_path``
is the path embedded in the XML, which lets a pack be built on Windows while
linking directly to the editor's mirrored media root on macOS.

Each source is probed with ffprobe for fps/size/duration so frame math is exact.
Why FCP7 XML (not EDL/FCPXML): Premiere links clips by file path here, so import
"just works" without manual relinking, and it carries video + linked stereo audio.

Usage: build_fcpxml.py <editlist.json> <out.xml>
"""
import json, os, re, subprocess, sys
from urllib.parse import quote
from xml.sax.saxutils import escape


def ffprobe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,width,height",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=0", path,
    ], text=True)
    d = {}
    for line in out.strip().splitlines():
        k, _, v = line.partition("=")
        d[k] = v
    num, den = (d["r_frame_rate"].split("/") + ["1"])[:2]
    fps = float(num) / float(den)
    timebase = round(fps)
    ntsc = "TRUE" if abs(timebase - fps) > 0.01 else "FALSE"
    return {
        "fps": fps, "timebase": timebase, "ntsc": ntsc,
        "width": int(d["width"]), "height": int(d["height"]),
        "frames": round(float(d["duration"]) * fps),
    }


def pathurl(path):
    # os.path.abspath('/Volumes/...') on Windows incorrectly prefixes the
    # current drive. Preserve already-absolute paths in either platform's form.
    normalized = str(path).replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", normalized):
        normalized = "/" + normalized
    elif not normalized.startswith("/"):
        normalized = os.path.abspath(path).replace("\\", "/")
        if re.match(r"^[A-Za-z]:/", normalized):
            normalized = "/" + normalized
    return "file://localhost" + quote(normalized, safe="/:")


def rate_xml(tb, ntsc):
    return f"<rate><timebase>{tb}</timebase><ntsc>{ntsc}</ntsc></rate>"


def build(editlist):
    name = escape(str(editlist.get("name", "Videoscan Cut")))
    probed = []
    for c in editlist["clips"]:
        m = ffprobe(c["path"])
        probed.append((c, m))

    if not probed:
        raise ValueError("edit list must contain at least one clip")

    first_meta = probed[0][1]
    seq_tb = first_meta["timebase"]
    seq_ntsc = first_meta["ntsc"]
    seq_w = first_meta["width"]
    seq_h = first_meta["height"]
    seq_fps = first_meta["fps"]

    segs = []
    pos = 0
    for c, m in probed:
        inf = round(c["in"] * m["fps"])
        outf = round(c["out"] * m["fps"])
        # in/out use source frames; start/end use sequence frames. Keeping
        # those clocks separate matters when a select reel mixes 24/30/60 fps.
        length = max(1, round((c["out"] - c["in"]) * seq_fps))
        segs.append({"c": c, "m": m, "in": inf, "out": outf,
                     "start": pos, "end": pos + length})
        pos += length
    total = pos

    vid_items, aud1_items, aud2_items = [], [], []
    file_ids = {}  # (local path, target path) -> file id (reuse)
    cid = [0]
    def nid():
        cid[0] += 1
        return cid[0]

    for s in segs:
        c, m = s["c"], s["m"]
        path = c["path"]
        target_path = c.get("target_path", path)
        file_key = (path, target_path)
        fname = escape(str(c.get("name") or os.path.basename(path)))
        if file_key not in file_ids:
            file_ids[file_key] = f"file-{len(file_ids)+1}"
            file_def = (
                f'<file id="{file_ids[file_key]}"><name>{fname}</name>'
                f'<pathurl>{escape(pathurl(target_path))}</pathurl>'
                f'{rate_xml(m["timebase"], m["ntsc"])}'
                f'<duration>{m["frames"]}</duration>'
                f'<media><video><samplecharacteristics>{rate_xml(m["timebase"], m["ntsc"])}'
                f'<width>{m["width"]}</width><height>{m["height"]}</height></samplecharacteristics></video>'
                f'<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>'
                f'<channelcount>2</channelcount></audio></media></file>'
            )
        else:
            file_def = f'<file id="{file_ids[file_key]}"/>'

        vid_id = f"clipitem-{nid()}"
        a1_id = f"clipitem-{nid()}"
        a2_id = f"clipitem-{nid()}"
        links = (
            f'<link><linkclipref>{vid_id}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
            f'<link><linkclipref>{a1_id}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
            f'<link><linkclipref>{a2_id}</linkclipref><mediatype>audio</mediatype><trackindex>2</trackindex><clipindex>1</clipindex></link>'
        )
        description = escape(str(c.get("description", "")))
        logging = f'<logginginfo><description>{description}</description></logginginfo>' if description else ""
        common = (f'<name>{fname}</name><duration>{m["frames"]}</duration>'
                  f'{rate_xml(m["timebase"], m["ntsc"])}'
                  f'<start>{s["start"]}</start><end>{s["end"]}</end>'
                  f'<in>{s["in"]}</in><out>{s["out"]}</out>{logging}')
        vid_items.append(f'<clipitem id="{vid_id}">{common}{file_def}{links}</clipitem>')
        # audio clipitems reference same file by id; sourcetrack picks the channel
        for aid, ch, bucket in ((a1_id, 1, aud1_items), (a2_id, 2, aud2_items)):
            bucket.append(
                f'<clipitem id="{aid}">{common}<file id="{file_ids[file_key]}"/>'
                f'<sourcetrack><mediatype>audio</mediatype><trackindex>{ch}</trackindex></sourcetrack>'
                f'{links}</clipitem>'
            )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n'
        f'<sequence id="sequence-1"><name>{name}</name><duration>{total}</duration>'
        f'{rate_xml(seq_tb, seq_ntsc)}<media>'
        f'<video><format><samplecharacteristics>{rate_xml(seq_tb, seq_ntsc)}'
        f'<width>{seq_w}</width><height>{seq_h}</height>'
        f'<pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>'
        f'</samplecharacteristics></format><track>{"".join(vid_items)}</track></video>'
        f'<audio><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>'
        f'<track>{"".join(aud1_items)}</track><track>{"".join(aud2_items)}</track></audio>'
        f'</media></sequence>\n</xmeml>\n'
    )
    return xml


def main():
    with open(sys.argv[1], encoding="utf-8") as source:
        editlist = json.load(source)
    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as target:
        target.write(build(editlist))
    print(f"wrote {sys.argv[2]} ({len(editlist['clips'])} clips)")


if __name__ == "__main__":
    main()
