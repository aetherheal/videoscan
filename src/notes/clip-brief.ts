import { needsHumanReview, type ClipSpec } from "../config/schema.js";

// Minimal YAML-safe double-quoted scalar (also normalizes Windows backslashes).
// Mirrors the helper in transcribe-note.ts so briefs and scan notes share style.
function yamlStr(s: string): string {
  return '"' + s.replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
}

// Render ONE Layer-4 ClipSpec as an Obsidian-friendly "viral short" brief:
// YAML frontmatter (so shorts are queryable in Obsidian) + a human cut sheet
// (hook → timecoded caption script → payoff → rationale). This is the per-short
// .md the editor works from; the ClipSpec stays the machine-readable source.
export function composeBrief(
  clip: ClipSpec,
  rank: number,
  shootDate: string | null,
): string {
  const review = needsHumanReview(clip);
  const tags = [
    "튠의원",
    "viral-short",
    `hook-${clip.hook_type}`,
    `driver-${clip.shareability_driver}`,
    review ? "manual-review" : "auto-ok",
  ];

  const frontmatter = [
    "---",
    `clip_id: ${yamlStr(clip.clip_id)}`,
    `source_file: ${yamlStr(clip.source_file)}`,
    shootDate ? `shoot_date: ${shootDate}` : null,
    `rank: ${rank}`,
    `virality_score: ${clip.virality_score}`,
    `status: ${review ? "review" : "auto"}`,
    `language: ${clip.language}`,
    `start: ${yamlStr(clip.start)}`,
    `end: ${yamlStr(clip.end)}`,
    `duration_sec: ${clip.duration_sec}`,
    `hook_type: ${clip.hook_type}`,
    `shareability_driver: ${clip.shareability_driver}`,
    `brand_safety: ${clip.brand_safety}`,
    `reframe_advice: ${clip.reframe_advice}`,
    `tags: [${tags.map(yamlStr).join(", ")}]`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const caps = clip.captions.length
    ? clip.captions.map((c) => `- \`${c.start} → ${c.end}\`  ${c.text}`).join("\n")
    : "_(no caption timing returned)_";

  // Surface the two human-queue flags prominently — these clips must never be
  // auto-rendered (see CLAUDE.md brand boundary).
  const flags: string[] = [];
  if (clip.brand_safety === "review") {
    flags.push(
      `> [!warning] 브랜드/의료법 검토 필요 (brand safety: review)\n> ${clip.brand_safety_reason ?? "(no reason given)"}`,
    );
  }
  if (clip.reframe_advice === "manual-review") {
    flags.push(
      `> [!warning] 영상 직접 확인 필요 (reframe: manual-review) — 가치가 시각 요소에 의존할 수 있음`,
    );
  }
  const flagBlock = flags.length ? flags.join("\n\n") + "\n\n" : "";

  const statusBadge = review ? "🔶 검토 필요 (human review)" : "✅ auto";

  return (
    `${frontmatter}\n\n` +
    `# 🎬 ${clip.clip_id} — ${clip.virality_score}/10  ${statusBadge}\n\n` +
    `> **Source:** ${clip.source_file}  ·  ` +
    `**Cut:** \`${clip.start}\` → \`${clip.end}\` (${clip.duration_sec}s)  ·  ` +
    `**Lang:** ${clip.language}\n\n` +
    flagBlock +
    `## 🪝 Hook — ${clip.hook_type}\n\n` +
    `**On-screen text (자막):** ${clip.hook_overlay}\n\n` +
    `## 💬 Caption cut sheet\n\n${caps}\n\n` +
    `## 🎯 Payoff\n\n${clip.payoff_line}\n\n` +
    `## 📈 Why it works — ${clip.shareability_driver}\n\n${clip.virality_rationale}\n`
  );
}
