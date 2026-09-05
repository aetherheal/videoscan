export type ReviewStatus = "unreviewed" | "keep" | "maybe" | "reject";

export interface ReviewPageItem {
  id: string;
  kind: "viral" | "scene";
  group: string;
  source_file: string;
  source_relative: string;
  target_path: string;
  start: number;
  end: number;
  duration: number;
  description: string;
  spoken_excerpt: string | null;
  tags: string[];
  content_type: string;
  shot_type: string;
  is_b_roll: boolean;
  proxy_path: string | null;
  score?: number;
  virality_score?: number;
  hook_overlay?: string;
  payoff_line?: string;
  flags: string[];
}

export interface ReviewPageLink {
  label: string;
  href: string;
  count: number;
}

export interface ReviewPagePayload {
  version: 1;
  name: string;
  generated_at: string;
  target_media_root: string;
  items: ReviewPageItem[];
  premiere_xml: ReviewPageLink[];
  warnings: string[];
}

function scriptJson(value: unknown): string {
  // Model-produced descriptions are untrusted input. Escaping '<' prevents a
  // literal </script> from terminating the inline data block.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildReviewHtml(payload: ReviewPagePayload): string {
  const data = scriptJson(payload);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${payload.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0c0f; --panel:#15171c; --line:#2b2f38; --text:#f3f4f6; --muted:#9ca3af; --lime:#c7f36b; --blue:#7dd3fc; --red:#fb7185; --amber:#fbbf24; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at 15% -10%,#26331c 0,transparent 32rem),var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    .shell { width:min(1500px,calc(100% - 32px)); margin:0 auto; padding:34px 0 72px; }
    .eyebrow { color:var(--lime); font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    h1 { margin:5px 0 4px; font-size:clamp(28px,4vw,52px); line-height:1.03; letter-spacing:-.04em; }
    .sub { color:var(--muted); max-width:850px; }
    .stats,.downloads { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
    .stat,.download { border:1px solid var(--line); background:#111319cc; border-radius:999px; padding:8px 13px; }
    .stat strong { color:var(--lime); }
    .download { color:var(--text); text-decoration:none; }
    .download:hover { border-color:var(--lime); }
    .toolbar { position:sticky; top:0; z-index:10; display:grid; grid-template-columns:minmax(240px,1fr) repeat(3,minmax(125px,auto)) auto; gap:9px; margin:28px 0 18px; padding:12px; background:#0b0c0fe8; border:1px solid var(--line); border-radius:16px; backdrop-filter:blur(15px); }
    .toolbar input,.toolbar select,.toolbar button,.note { color:var(--text); background:#171a20; border:1px solid #343945; border-radius:10px; padding:10px 12px; }
    .toolbar button { cursor:pointer; background:var(--lime); color:#172008; border-color:var(--lime); font-weight:800; }
    #results { display:grid; grid-template-columns:repeat(auto-fill,minmax(390px,1fr)); gap:15px; }
    .card { overflow:hidden; border:1px solid var(--line); border-radius:16px; background:linear-gradient(145deg,#181b21,#111319); box-shadow:0 14px 34px #0005; }
    .preview { aspect-ratio:16/9; width:100%; display:grid; place-items:center; background:#090a0d; color:#6b7280; }
    video.preview { object-fit:contain; }
    .body { padding:15px; }
    .pills { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
    .pill { padding:3px 8px; border-radius:999px; background:#252933; color:#cbd5e1; font-size:11px; font-weight:700; }
    .pill.viral { color:#151c08; background:var(--lime); }
    .pill.flag { color:#291604; background:var(--amber); }
    .title { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .title h2 { font-size:16px; margin:0; overflow-wrap:anywhere; }
    .time { white-space:nowrap; color:var(--blue); font-variant-numeric:tabular-nums; }
    .path { color:var(--muted); font-size:12px; margin-top:3px; overflow-wrap:anywhere; }
    .description { margin:13px 0 0; font-size:15px; }
    .spoken { margin:10px 0 0; padding-left:10px; border-left:2px solid #3f4654; color:#cbd5e1; }
    .hook { margin:10px 0 0; color:var(--lime); font-weight:750; }
    .tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:12px; color:#9ca3af; font-size:11px; }
    .review { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:15px; }
    .review button,.copy { cursor:pointer; border:1px solid #343945; color:#d1d5db; background:#1d2027; border-radius:9px; padding:8px; }
    .review button.active[data-status="keep"] { background:#245433; border-color:#4ade80; }
    .review button.active[data-status="maybe"] { background:#614313; border-color:var(--amber); }
    .review button.active[data-status="reject"] { background:#652536; border-color:var(--red); }
    .note { width:100%; min-height:42px; resize:vertical; margin-top:7px; }
    .copy { width:100%; margin-top:7px; }
    .empty { grid-column:1/-1; padding:48px; text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:16px; }
    .warnings { margin-top:18px; color:#fcd34d; }
    @media(max-width:850px) { .toolbar { grid-template-columns:1fr 1fr; } .toolbar input { grid-column:1/-1; } #results { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">Videoscan AI · PD Select Pack</div>
    <h1 id="pack-name"></h1>
    <div class="sub" id="subtitle"></div>
    <div class="stats" id="stats"></div>
    <div class="downloads" id="downloads"></div>
    <div class="warnings" id="warnings"></div>

    <section class="toolbar" aria-label="필터">
      <input id="search" type="search" placeholder="장면·대사·태그·파일명 검색">
      <select id="kind"><option value="all">전체 종류</option><option value="viral">바이럴 후보</option><option value="scene">장면</option></select>
      <select id="group"><option value="all">전체 그룹</option></select>
      <select id="status"><option value="all">전체 상태</option><option value="unreviewed">미검토</option><option value="keep">채택</option><option value="maybe">보류</option><option value="reject">제외</option></select>
      <button id="export" type="button">검토 결과 저장</button>
    </section>
    <div id="results"></div>
  </main>
  <script>
    const PACK = ${data};
    const STORAGE_KEY = "videoscan-pd-review-v1";
    const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; } })();
    const $ = (id) => document.getElementById(id);
    const make = (tag, className, text) => { const node=document.createElement(tag); if(className) node.className=className; if(text!==undefined) node.textContent=text; return node; };
    const pad = (n) => String(n).padStart(2,"0");
    const tc = (seconds) => { const ms=Math.max(0,Math.round(seconds*1000)); return pad(Math.floor(ms/3600000))+":"+pad(Math.floor(ms%3600000/60000))+":"+pad(Math.floor(ms%60000/1000))+"."+String(ms%1000).padStart(3,"0"); };
    const getReview = (id) => saved[id] || {status:"unreviewed",note:""};
    const persist = () => localStorage.setItem(STORAGE_KEY,JSON.stringify(saved));
    const copyText = async (value) => { try { await navigator.clipboard.writeText(value); } catch (_) { const t=document.createElement("textarea"); t.value=value; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); } };

    $("pack-name").textContent=PACK.name;
    $("subtitle").textContent="생성 "+new Date(PACK.generated_at).toLocaleString()+" · Premiere 연결 기준: "+PACK.target_media_root;
    const viralCount=PACK.items.filter(x=>x.kind==="viral").length;
    [["전체 후보",PACK.items.length],["바이럴",viralCount],["장면",PACK.items.length-viralCount]].forEach(([label,value])=>{ const s=make("span","stat"); s.append(label+" "); s.appendChild(make("strong","",String(value))); $("stats").appendChild(s); });
    PACK.premiere_xml.forEach(link=>{ const a=make("a","download",link.label+" · "+link.count+"컷"); a.href=link.href; a.setAttribute("download",""); $("downloads").appendChild(a); });
    if(PACK.warnings.length) $("warnings").textContent="주의: "+PACK.warnings.join(" · ");
    [...new Set(PACK.items.map(x=>x.group))].sort().forEach(value=>{ const o=make("option","",value); o.value=value; $("group").appendChild(o); });

    function setStatus(item,status,card){ saved[item.id]={...getReview(item.id),status}; persist(); card.querySelectorAll("[data-status]").forEach(b=>b.classList.toggle("active",b.dataset.status===status)); renderCount(); }
    function renderCard(item){
      const card=make("article","card");
      if(item.proxy_path){ const video=make("video","preview"); video.src=item.proxy_path; video.controls=true; video.preload="metadata"; video.playsInline=true; card.appendChild(video); }
      else card.appendChild(make("div","preview","프록시 없음 · 경로/타임코드로 확인"));
      const body=make("div","body"); const pills=make("div","pills");
      pills.appendChild(make("span","pill "+(item.kind==="viral"?"viral":""),item.kind==="viral"?"VIRAL":"SCENE"));
      pills.appendChild(make("span","pill",item.group));
      if(item.virality_score!==undefined) pills.appendChild(make("span","pill","점수 "+item.virality_score+"/10"));
      item.flags.forEach(flag=>pills.appendChild(make("span","pill flag",flag)));
      body.appendChild(pills);
      const title=make("div","title"); title.appendChild(make("h2","",item.source_file)); title.appendChild(make("div","time",tc(item.start)+" – "+tc(item.end))); body.appendChild(title);
      body.appendChild(make("div","path",item.source_relative));
      body.appendChild(make("p","description",item.description));
      if(item.hook_overlay) body.appendChild(make("p","hook","HOOK · "+item.hook_overlay));
      if(item.spoken_excerpt) body.appendChild(make("p","spoken","“"+item.spoken_excerpt+"”"));
      const tags=make("div","tags"); item.tags.forEach(tag=>tags.appendChild(make("span","","#"+tag))); body.appendChild(tags);
      const review=make("div","review"); [["unreviewed","미검토"],["keep","채택"],["maybe","보류"],["reject","제외"]].forEach(([status,label])=>{ const b=make("button","",label); b.type="button"; b.dataset.status=status; b.addEventListener("click",()=>setStatus(item,status,card)); review.appendChild(b); }); body.appendChild(review);
      const note=make("textarea","note"); note.placeholder="메모 또는 제외 이유"; note.value=getReview(item.id).note||""; note.addEventListener("change",()=>{saved[item.id]={...getReview(item.id),note:note.value};persist();}); body.appendChild(note);
      const copy=make("button","copy","Mac 경로 + 타임코드 복사"); copy.type="button"; copy.addEventListener("click",async()=>{await copyText(item.target_path+" @ "+tc(item.start)+"–"+tc(item.end)); copy.textContent="복사됨"; setTimeout(()=>copy.textContent="Mac 경로 + 타임코드 복사",900);}); body.appendChild(copy);
      card.appendChild(body); setStatus(item,getReview(item.id).status,card); return card;
    }
    function filtered(){ const q=$("search").value.trim().toLocaleLowerCase(); return PACK.items.filter(item=>{ const review=getReview(item.id); const haystack=JSON.stringify(item).toLocaleLowerCase(); return (!q||haystack.includes(q)) && ($("kind").value==="all"||item.kind===$("kind").value) && ($("group").value==="all"||item.group===$("group").value) && ($("status").value==="all"||review.status===$("status").value); }); }
    function renderCount(){ const counts={keep:0,maybe:0,reject:0,unreviewed:0}; PACK.items.forEach(item=>counts[getReview(item.id).status]++); $("export").textContent="검토 결과 저장 · 채택 "+counts.keep; }
    function render(){ const root=$("results"); root.replaceChildren(); const items=filtered(); if(!items.length) root.appendChild(make("div","empty","조건에 맞는 후보가 없습니다.")); else items.forEach(item=>root.appendChild(renderCard(item))); renderCount(); }
    ["search","kind","group","status"].forEach(id=>$(id).addEventListener(id==="search"?"input":"change",render));
    $("export").addEventListener("click",()=>{ const reviews=PACK.items.map(item=>({id:item.id,source_relative:item.source_relative,start:item.start,end:item.end,...getReview(item.id)})); const blob=new Blob([JSON.stringify({pack:PACK.name,exported_at:new Date().toISOString(),reviews},null,2)],{type:"application/json"}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="pd-review.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); });
    render();
  </script>
</body>
</html>
`;
}
