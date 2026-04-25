import type {
  FlatSegment,
  KepanPayload,
  SourceKey,
  TranscriptPayload,
} from "./lamrimTypes";
import { ALL_SOURCES, sourceOf, type TranscriptSourceConfig } from "./sources";

function publicDataUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  const p = path.replace(/^\//, "");
  return `${base}${p}`.replace(/([^:]\/)\/+/g, "$1");
}

function resolveDataUrl(relPath: string): string {
  const pathOnly = publicDataUrl(relPath);
  if (typeof window === "undefined") return pathOnly;
  if (pathOnly.startsWith("http://") || pathOnly.startsWith("https://")) return pathOnly;
  return `${window.location.origin}${pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`}`;
}

async function gunzipJson(buf: ArrayBuffer): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("此瀏覽器不支援 gzip 解壓（DecompressionStream）。");
  }
  const ds = new DecompressionStream("gzip");
  const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  return JSON.parse(out) as unknown;
}

async function fetchGzipJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const looksGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  if (looksGzip) return (await gunzipJson(buf)) as T;
  return JSON.parse(new TextDecoder("utf-8").decode(buf)) as T;
}

// 時間區間 label 由 source 設定處理（鳳山寺以原卷時間顯示、南普陀以音檔時間顯示）

function sourceBadgeHtml(seg: FlatSegment): string {
  const src = sourceOf(seg);
  const cls =
    src.key === "fengshan"
      ? "transcripts-source-badge is-fengshan"
      : "transcripts-source-badge is-nanputuo";
  return `<span class="${cls}">${src.title}</span>`;
}

export async function mountKepan(
  root: HTMLElement,
  opts: { onBack: () => void; onOpenSeg: (seg: { source: SourceKey; id: number }) => void },
): Promise<() => void> {
  root.innerHTML = `
    <div class="transcripts kepan">
      <div class="transcripts-toolbar">
        <button type="button" class="transcripts-back" id="kp-back">返回</button>
        <h1 class="transcripts-title">廣論科判</h1>
      </div>
      <p class="transcripts-hint" id="kp-hint">依《菩提道次第廣論》32 章節瀏覽；點章節可看對應南普陀版與鳳山寺版手抄段落。</p>
      <div id="kp-status" class="transcripts-status" role="status">載入中…</div>
      <div class="kepan-body">
        <div id="kp-tree" class="kepan-tree"></div>
        <div id="kp-hits" class="kepan-hits"></div>
      </div>
    </div>
  `;

  const btnBack = root.querySelector<HTMLButtonElement>("#kp-back")!;
  const statusEl = root.querySelector<HTMLDivElement>("#kp-status")!;
  const treeEl = root.querySelector<HTMLDivElement>("#kp-tree")!;
  const hitsEl = root.querySelector<HTMLDivElement>("#kp-hits")!;

  btnBack.addEventListener("click", () => opts.onBack());

  let payload: KepanPayload | null = null;
  const segById = new Map<string, FlatSegment>();

  try {
    const [kp, ...sourceLoads] = await Promise.all([
      fetchGzipJson<KepanPayload>(resolveDataUrl("data/lamrim-kepan.json.gz")),
      ...ALL_SOURCES.map((s) =>
        fetchGzipJson<TranscriptPayload>(resolveDataUrl(s.dataPath)).then((p) => ({
          source: s,
          data: p,
        })),
      ),
    ]);
    payload = kp;
    for (const { source, data } of sourceLoads as Array<{
      source: TranscriptSourceConfig;
      data: TranscriptPayload;
    }>) {
      for (const seg of data.flatSegments) {
        if (!seg.sourceKey) seg.sourceKey = source.key;
        segById.set(`${source.key}:${seg.id}`, seg);
      }
    }
  } catch (e) {
    statusEl.textContent = `載入失敗：${String(e)}`;
    return () => { /* noop */ };
  }

  // 每章節 segment 清單（分版）
  const segsBySection = new Map<number, { np: FlatSegment[]; fg: FlatSegment[] }>();
  for (let i = 0; i < payload.sections.length; i++) {
    segsBySection.set(i, { np: [], fg: [] });
  }
  const enroll = (src: SourceKey, map: Record<string, number>) => {
    for (const [idStr, si] of Object.entries(map)) {
      const bucket = segsBySection.get(si);
      if (!bucket) continue;
      const seg = segById.get(`${src}:${idStr}`);
      if (!seg) continue;
      (src === "fengshan" ? bucket.fg : bucket.np).push(seg);
    }
  };
  enroll("nanputuo", payload.assignments.nanputuo);
  enroll("fengshan", payload.assignments.fengshan);
  // 每章節內依 pageSlug + entryIndex 排序（閱讀順序）
  for (const bucket of segsBySection.values()) {
    const cmp = (a: FlatSegment, b: FlatSegment) => {
      const pa = Number.parseInt(a.pageSlug, 10);
      const pb = Number.parseInt(b.pageSlug, 10);
      if (pa !== pb) return pa - pb;
      if (a.entryIndex !== b.entryIndex) return a.entryIndex - b.entryIndex;
      return a.id - b.id;
    };
    bucket.np.sort(cmp);
    bucket.fg.sort(cmp);
  }

  const LAST_SECTION_KEY = "kepan.lastSection";
  const readLastSection = (): number | null => {
    try {
      const raw = window.sessionStorage.getItem(LAST_SECTION_KEY);
      if (raw == null) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 && n < payload!.sections.length ? n : null;
    } catch {
      return null;
    }
  };
  const writeLastSection = (idx: number) => {
    try { window.sessionStorage.setItem(LAST_SECTION_KEY, String(idx)); } catch { /* ignore */ }
  };

  let activeSectionIndex = -1;
  let openGroupIndex = -1;

  const renderHits = (sectionIndex: number) => {
    activeSectionIndex = sectionIndex;
    writeLastSection(sectionIndex);
    const bucket = segsBySection.get(sectionIndex);
    const section = payload!.sections[sectionIndex]!;
    if (!bucket || (bucket.np.length === 0 && bucket.fg.length === 0)) {
      hitsEl.innerHTML = `<div class="transcripts-group-header">${section.name}</div><p class="transcripts-hint">此章節尚無對應手抄段落。</p>`;
      return;
    }
    const makeCard = (seg: FlatSegment): string => {
      const src = sourceOf(seg);
      const preview =
        (seg.quoteText.length > 0 ? seg.quoteText : seg.explanationText).slice(0, 80) +
        ((seg.quoteText.length || seg.explanationText.length) > 80 ? "…" : "");
      return `<button type="button" class="transcripts-hit is-${src.key}" data-src="${src.key}" data-id="${seg.id}">
        <span class="transcripts-hit-meta">${sourceBadgeHtml(seg)} ${src.tapeLabel(seg)} · ${src.formatTimeLabel(seg)}</span>
        <span class="transcripts-hit-q">${preview}</span>
      </button>`;
    };
    const parts: string[] = [];
    parts.push(`<div class="kepan-section-header">${section.name}</div>`);
    // 兩版皆以 <details> 包起：鳳山寺預設展開、南普陀預設摺疊，
    // 避免使用者每次都要滑過長長的南普陀清單才看到鳳山寺版本
    if (bucket.fg.length) {
      parts.push(`<details class="kepan-source-group" open>
        <summary class="transcripts-group-header is-fengshan">鳳山寺版（${bucket.fg.length} 筆）</summary>`);
      for (const s of bucket.fg) parts.push(makeCard(s));
      parts.push(`</details>`);
    }
    if (bucket.np.length) {
      parts.push(`<details class="kepan-source-group">
        <summary class="transcripts-group-header is-nanputuo">南普陀版（${bucket.np.length} 筆）</summary>`);
      for (const s of bucket.np) parts.push(makeCard(s));
      parts.push(`</details>`);
    }
    hitsEl.innerHTML = parts.join("");
    hitsEl.querySelectorAll<HTMLButtonElement>(".transcripts-hit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const src = btn.dataset.src as SourceKey | undefined;
        const idStr = btn.dataset.id;
        if (!src || !idStr) return;
        const id = Number.parseInt(idStr, 10);
        if (!Number.isFinite(id)) return;
        opts.onOpenSeg({ source: src, id });
      });
    });
  };

  const renderTree = () => {
    const parts: string[] = [];
    for (const g of payload!.groups) {
      const secInGroup = g.sectionIndexes
        .map((idx) => {
          const sec = payload!.sections[idx]!;
          const bucket = segsBySection.get(idx)!;
          return { idx, sec, np: bucket.np.length, fg: bucket.fg.length };
        })
        .filter((x) => x.np + x.fg > 0 || true); // keep all even zero to show structure
      const totalNp = secInGroup.reduce((a, b) => a + b.np, 0);
      const totalFg = secInGroup.reduce((a, b) => a + b.fg, 0);
      const expanded = openGroupIndex === g.index;
      parts.push(`<details class="kepan-group"${expanded ? " open" : ""}>
        <summary class="kepan-group-summary">${g.name} <span class="kepan-counts">南普陀 ${totalNp} · 鳳山寺 ${totalFg}</span></summary>
        <ul class="kepan-section-list">`);
      for (const { idx, sec, np, fg } of secInGroup) {
        parts.push(`<li><button type="button" class="kepan-section-btn" data-section="${idx}">
          <span class="kepan-section-name">${sec.name}</span>
          <span class="kepan-section-counts">南 ${np} · 鳳 ${fg}</span>
        </button></li>`);
      }
      parts.push(`</ul></details>`);
    }
    treeEl.innerHTML = parts.join("");
    treeEl.querySelectorAll<HTMLButtonElement>(".kepan-section-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const si = Number.parseInt(btn.dataset.section || "", 10);
        if (!Number.isFinite(si)) return;
        treeEl.querySelectorAll(".kepan-section-btn.is-active").forEach((el) => el.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderHits(si);
      });
    });
  };

  const totalAssigned =
    Object.keys(payload.assignments.nanputuo).length +
    Object.keys(payload.assignments.fengshan).length;
  statusEl.textContent = `已載入 ${payload.sections.length} 章節、${totalAssigned} 筆分類段落。`;

  // Decide which section to auto-show:
  //   1) last visited (from sessionStorage, e.g. when returning from detail page)
  //   2) otherwise: leave tree collapsed and hits empty
  const lastSection = readLastSection();
  if (lastSection != null) {
    const sec = payload.sections[lastSection]!;
    openGroupIndex = sec.group;
  }
  renderTree();
  if (lastSection != null) {
    const btn = treeEl.querySelector<HTMLButtonElement>(`.kepan-section-btn[data-section="${lastSection}"]`);
    if (btn) {
      btn.classList.add("is-active");
      renderHits(lastSection);
      btn.scrollIntoView({ block: "nearest" });
    }
  } else {
    hitsEl.innerHTML = `<p class="transcripts-hint">展開左側分組，點選章節即可顯示對應手抄段落。</p>`;
  }
  void activeSectionIndex;

  return () => {
    // No persistent resources to clean up beyond closures
  };
}
