#!/usr/bin/env python3
"""Layer 3 — faster-whisper ASR with word-level timestamps.

Reads an audio/video file, transcribes it with word timestamps ON (mandatory for
the clean cuts Layer 4 / Layer 5 depend on), and writes a JSON transcript to
stdout in the shape src/types.ts:WhisperTranscript expects.

The TS orchestrator (src/layers/layer3-asr.ts) spawns this as a subprocess, so
keep stdout to the JSON payload only — all logging goes to stderr.
"""
import argparse
import json
import sys


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="faster-whisper ASR (word-level)")
    parser.add_argument("--input", required=True, help="path to audio/video file")
    parser.add_argument("--model", default="large-v3", help="whisper model size")
    parser.add_argument(
        "--device",
        default="auto",
        help="cpu | cuda | auto (faster-whisper picks the best available)",
    )
    parser.add_argument(
        "--compute-type",
        default="default",
        help="e.g. int8, float16; 'default' lets faster-whisper choose",
    )
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="disable voice-activity detection. VAD is ON by default and is what "
        "stops Whisper from hallucinating text over silent/ambient B-roll.",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        eprint(
            "faster-whisper not installed. Create the venv and install deps:\n"
            "  python3 -m venv python/.venv\n"
            "  python/.venv/bin/pip install -r python/requirements.txt"
        )
        return 1

    # Resolve device/compute-type. "default" compute on CPU lands on float32
    # (slow), so pick int8 for CPU (2-4x faster, negligible accuracy loss) and
    # float16 for CUDA. Honour an explicit --compute-type/--device if given.
    device = args.device
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"

    compute_type = args.compute_type
    if compute_type == "default":
        compute_type = "float16" if device == "cuda" else "int8"

    eprint(f"[asr] loading model={args.model} device={device} compute_type={compute_type}")
    model = WhisperModel(args.model, device=device, compute_type=compute_type)

    use_vad = not args.no_vad
    eprint(f"[asr] transcribing {args.input} (vad={'on' if use_vad else 'off'})")
    # vad_filter drops non-speech audio before decoding — essential for mixed
    # footage where some clips (procedure B-roll) have no speech at all.
    segments_iter, info = model.transcribe(
        args.input, word_timestamps=True, vad_filter=use_vad
    )

    segments = []
    for seg in segments_iter:
        words = [
            {"start": w.start, "end": w.end, "word": w.word}
            for w in (seg.words or [])
        ]
        segments.append(
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "words": words,
            }
        )
        eprint(f"[asr] [{seg.start:7.2f} -> {seg.end:7.2f}] {seg.text.strip()}")

    transcript = {
        "source_file": args.input,
        "language": info.language,
        "duration": info.duration,
        "segments": segments,
    }

    json.dump(transcript, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
