#!/usr/bin/env python3
"""Generate a Premiere-importable FCP7 XML (xmeml v4) timeline from an edit list.

Edit list JSON:
  {"name": "My Cut", "clips": [{"path": "/abs/clip.mp4", "in": 0.0, "out": 7.6}, ...]}
in/out are seconds into each source. Clips are laid end-to-end on V1/A1/A2.

Each source is probed with ffprobe for fps/size/duration so frame math is exact.
Why FCP7 XML (not EDL/FCPXML): Premiere links clips by file path here, so import
"just works" without manual relinking, and it carries video + linked stereo audio.

Usage: build_fcpxml.py <editlist.json> <out.xml>
"""
import json, os, subprocess, sys
from urllib.parse import quote


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
    return "file://localhost" + quote(os.path.abspath(path))


def rate_xml(tb, ntsc):
    return f"<rate><timebase>{tb}</timebase><ntsc>{ntsc}</ntsc></rate>"


def build(editlist):
    name = editlist.get("name", "Videoscan Cut")
    segs = []
    seq_tb = seq_ntsc = seq_w = seq_h = None
    file_ids = {}  # path -> file id (reuse)
    pos = 0
    for c in editlist["clips"]:
        m = ffprobe(c["path"])
        if seq_tb is None:
            seq_tb, seq_ntsc, seq_w, seq_h = m["timebase"], m["ntsc"], m["width"], m["height"]
        inf = round(c["in"] * m["fps"])
        outf = round(c["out"] * m["fps"])
        length = max(1, outf - inf)
        segs.append({"c": c, "m": m, "in": inf, "out": outf,
                     "start": pos, "end": pos + length})
        pos += length
    total = pos

    vid_items, aud1_items, aud2_items = [], [], []
    cid = [0]
    def nid():
        cid[0] += 1
        return cid[0]

    for s in segs:
        c, m = s["c"], s["m"]
        path = c["path"]
        fname = os.path.basename(path)
        if path not in file_ids:
            file_ids[path] = f"file-{len(file_ids)+1}"
            file_def = (
                f'<file id="{file_ids[path]}"><name>{fname}</name>'
                f'<pathurl>{pathurl(path)}</pathurl>'
                f'{rate_xml(m["timebase"], m["ntsc"])}'
                f'<duration>{m["frames"]}</duration>'
                f'<media><video><samplecharacteristics>{rate_xml(m["timebase"], m["ntsc"])}'
                f'<width>{m["width"]}</width><height>{m["height"]}</height></samplecharacteristics></video>'
                f'<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>'
                f'<channelcount>2</channelcount></audio></media></file>'
            )
        else:
            file_def = f'<file id="{file_ids[path]}"/>'

        vid_id = f"clipitem-{nid()}"
        a1_id = f"clipitem-{nid()}"
        a2_id = f"clipitem-{nid()}"
        links = (
            f'<link><linkclipref>{vid_id}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
            f'<link><linkclipref>{a1_id}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
            f'<link><linkclipref>{a2_id}</linkclipref><mediatype>audio</mediatype><trackindex>2</trackindex><clipindex>1</clipindex></link>'
        )
        common = (f'<name>{fname}</name><duration>{m["frames"]}</duration>'
                  f'{rate_xml(m["timebase"], m["ntsc"])}'
                  f'<start>{s["start"]}</start><end>{s["end"]}</end>'
                  f'<in>{s["in"]}</in><out>{s["out"]}</out>')
        vid_items.append(f'<clipitem id="{vid_id}">{common}{file_def}{links}</clipitem>')
        # audio clipitems reference same file by id; sourcetrack picks the channel
        for aid, ch, bucket in ((a1_id, 1, aud1_items), (a2_id, 2, aud2_items)):
            bucket.append(
                f'<clipitem id="{aid}">{common}<file id="{file_ids[path]}"/>'
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
    editlist = json.load(open(sys.argv[1]))
    open(sys.argv[2], "w").write(build(editlist))
    print(f"wrote {sys.argv[2]} ({len(editlist['clips'])} clips)")


if __name__ == "__main__":
    main()
