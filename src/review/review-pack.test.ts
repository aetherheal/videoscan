import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asrEnv } from "../config/env.js";
import { buildReviewPack, parseReviewPackArgs } from "./build-pack.js";
import { MediaLibrary } from "./media-map.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "videoscan-review-test-"));
}

test("MediaLibrary creates a portable target path and rejects ambiguous basenames", () => {
  const root = tempRoot();
  try {
    const mediaRoot = join(root, "media");
    mkdirSync(join(mediaRoot, "2026-09-05"), { recursive: true });
    const clip = join(mediaRoot, "2026-09-05", "clip one.mp4");
    writeFileSync(clip, "fixture");

    const library = new MediaLibrary(mediaRoot, "/Volumes/Clinic Recordings");
    assert.deepEqual(library.resolve(null, "clip one.mp4"), {
      localPath: clip,
      relativePath: "2026-09-05/clip one.mp4",
      targetPath: "/Volumes/Clinic Recordings/2026-09-05/clip one.mp4",
    });

    mkdirSync(join(mediaRoot, "2026-09-06"), { recursive: true });
    writeFileSync(join(mediaRoot, "2026-09-06", "clip one.mp4"), "fixture");
    const ambiguous = new MediaLibrary(mediaRoot, "/Volumes/Clinic Recordings");
    assert.throws(() => ambiguous.resolve(null, "clip one.mp4"), /ambiguous media basename/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review pack generates playable proxies and portable well-formed Premiere XML", { timeout: 60_000 }, () => {
  const root = tempRoot();
  try {
    const mediaRoot = join(root, "media");
    const shootDir = join(mediaRoot, "2026-09-05");
    const videoPath = join(shootDir, "clip & one.mp4");
    const shortsRoot = join(root, "shorts");
    const outDir = join(root, "pack");
    mkdirSync(shootDir, { recursive: true });
    mkdirSync(join(shortsRoot, "2026-09-05"), { recursive: true });

    const media = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x35523d:s=320x180:r=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", videoPath,
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    assert.equal(media.status, 0, media.stderr || media.error?.message);

    const catalogPath = join(root, "footage-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      clip_count: 1,
      scene_count: 1,
      scenes: [{
        id: "fixture#scene-0",
        index_file: "fixture/footage-index.json",
        source_file: "clip & one.mp4",
        source_path: videoPath,
        clip_duration: 3,
        summary: "A doctor walks through the clinic.",
        content_type: "vlog",
        language: "ko",
        has_speech: true,
        scene_index: 0,
        start: 0,
        end: 2.5,
        duration: 2.5,
        shot_type: "interior",
        setting: "clinic hallway",
        description: "Doctor walks through a bright clinic hallway.",
        people: ["doctor"],
        is_b_roll: false,
        spoken_excerpt: "오늘은 병원을 둘러보겠습니다.",
        tags: ["doctor", "clinic", "hallway"],
        usable_for: ["vlog-opening"],
      }],
    }, null, 2));

    writeFileSync(join(shortsRoot, "2026-09-05", "clip & one.shorts.json"), JSON.stringify([{
      clip_id: "clip-one-short-01",
      source_file: "clip & one.mp4",
      language: "ko",
      start: "00:00:00.200",
      end: "00:00:01.500",
      duration_sec: 1.3,
      hook_type: "curiosity_gap",
      hook_overlay: "병원 안쪽은 어떻게 생겼을까?",
      captions: [{ start: "00:00:00.200", end: "00:00:01.500", text: "오늘은 병원을 둘러보겠습니다." }],
      payoff_line: "진료 동선을 한 번에 확인합니다.",
      shareability_driver: "insider_authority",
      virality_score: 8.4,
      virality_rationale: "내부 공간을 짧고 명확하게 소개한다.",
      brand_safety: "pass",
      brand_safety_reason: null,
      reframe_advice: "speaker-centered",
    }], null, 2));

    const result = buildReviewPack({
      sourceRoot: mediaRoot,
      targetRoot: "/Volumes/Clinic Recordings",
      catalogPath,
      shortsRoot,
      outDir,
      name: "Fixture PD Pack",
      queries: ["doctor clinic"],
      proxyHeight: 180,
    });

    assert.equal(result.itemCount, 2);
    assert.equal(result.viralCount, 1);
    assert.equal(result.sceneCount, 1);
    assert.equal(result.proxyCount, 2);
    assert.equal(result.xmlPaths.length, 2);
    assert.deepEqual(result.warnings, []);

    const html = readFileSync(result.htmlPath, "utf8");
    const data = JSON.parse(readFileSync(result.dataPath, "utf8")) as {
      items: Array<{ source_relative: string; target_path: string; proxy_path: string }>;
    };
    assert.match(html, /PD Select Pack/u);
    const inlineScript = html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    assert.ok(inlineScript, "review page should contain its offline application script");
    assert.doesNotThrow(() => Function(inlineScript), "review page script should parse");
    assert.doesNotMatch(html, new RegExp(mediaRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.equal(data.items[0]?.source_relative, "2026-09-05/clip & one.mp4");
    assert.equal(data.items[0]?.target_path, "/Volumes/Clinic Recordings/2026-09-05/clip & one.mp4");
    assert.match(data.items[0]?.proxy_path ?? "", /^proxies\/[a-f0-9]+\.mp4$/u);

    for (const xmlPath of result.xmlPaths) {
      const xml = readFileSync(xmlPath, "utf8");
      assert.match(xml, /file:\/\/localhost\/Volumes\/Clinic%20Recordings\/2026-09-05\/clip%20%26%20one\.mp4/u);
      assert.doesNotMatch(xml, /videoscan-review-test/u);
      const parsed = spawnSync(
        asrEnv().python,
        ["-c", "import sys, xml.etree.ElementTree as E; E.parse(sys.argv[1])", xmlPath],
        { encoding: "utf8" },
      );
      assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI parser supports repeated searches and generation switches", () => {
  const parsed = parseReviewPackArgs([
    "--source-root", "F:\\Recordings",
    "--media-root", "/Volumes/Recordings",
    "--query", "sunset drone",
    "--query", "doctor hallway",
    "--limit", "8",
    "--no-proxies",
  ]);
  assert.deepEqual(parsed.queries, ["sunset drone", "doctor hallway"]);
  assert.equal(parsed.limitPerQuery, 8);
  assert.equal(parsed.generateProxies, false);
});

test("an unreadable Drive placeholder is reported without discarding the HTML pack", () => {
  const root = tempRoot();
  try {
    const mediaRoot = join(root, "media");
    const broken = join(mediaRoot, "broken.mp4");
    const catalogPath = join(root, "catalog.json");
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(broken, "not an mp4");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      clip_count: 1,
      scene_count: 1,
      scenes: [{
        id: "broken#0", index_file: "broken/footage-index.json",
        source_file: "broken.mp4", source_path: broken, clip_duration: 3,
        summary: "broken fixture", content_type: "other", language: "unknown",
        has_speech: false, scene_index: 0, start: 0, end: 2, duration: 2,
        shot_type: "other", setting: "unknown", description: "Unreadable fixture",
        people: [], is_b_roll: true, spoken_excerpt: null, tags: ["broken"],
        usable_for: [],
      }],
    }));

    const result = buildReviewPack({
      sourceRoot: mediaRoot,
      targetRoot: "/Volumes/Recordings",
      catalogPath,
      shortsRoot: join(root, "missing-shorts"),
      outDir: join(root, "pack"),
      generateProxies: false,
    });
    assert.equal(result.itemCount, 1);
    assert.equal(result.xmlPaths.length, 0);
    assert.match(result.warnings.join("\n"), /Premiere XML에서 읽을 수 없는 원본 제외/u);
    assert.doesNotMatch(result.warnings.join("\n"), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.match(readFileSync(result.htmlPath, "utf8"), /원본 읽기 실패/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
