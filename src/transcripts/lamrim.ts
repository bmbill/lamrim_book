import type { AudioPlanStep, FlatSegment, TranscriptPayload } from "./lamrimTypes";

function publicDataUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  const p = path.replace(/^\//, "");
  return `${base}${p}`.replace(/([^:]\/)\/+/g, "$1");
}

function resolveTranscriptsDataUrl(): string {
  const pathOnly = publicDataUrl("data/lamrim-transcripts.json.gz");
  if (typeof window === "undefined") return pathOnly;
  if (pathOnly.startsWith("http://") || pathOnly.startsWith("https://")) return pathOnly;
  return `${window.location.origin}${pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`}`;
}

/** 南普陀手抄稿於 AMEC 的課程代碼；與官網 lamrim-transcripts-nanputuo-XXX 之 XXX 對應同一數字。 */
const AMRTF_NANPUTUO_COURSE = "B000027";
const AMRTF_MP3_SUFFIX = "-48kHz-64kbs";

const amrtfUrlCache = new Map<string, string | null>();
const amrtfInflight = new Map<string, Promise<string | null>>();

let payloadCache: TranscriptPayload | null = null;

async function gunzipJson(buf: ArrayBuffer): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("此瀏覽器不支援 gzip 解壓（DecompressionStream），請改用 Chrome／Edge／Safari 較新版本。");
  }
  const ds = new DecompressionStream("gzip");
  const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  return JSON.parse(out) as unknown;
}

async function loadPayload(): Promise<TranscriptPayload> {
  if (payloadCache) return payloadCache;
  const url = resolveTranscriptsDataUrl();
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    const hint =
      "請確認 npm run dev 已啟動且 public/data/lamrim-transcripts.json.gz 存在；若曾用 PWA／preview 開過本站，請開發者工具 → Application → Service Workers → Unregister 後強制重新整理。";
    throw new Error(`無法連線載入逐字稿索引 ${url} — ${String(e)}。${hint}`);
  }
  if (!res.ok) throw new Error(`無法載入逐字稿索引：HTTP ${res.status}（${url}）`);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  /** 若伺服器回 Content-Encoding: gzip，fetch 多半已解壓，body 開頭為 `{` 而非 0x1f8b */
  const looksLikeGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  const parsed: unknown = looksLikeGzip
    ? await gunzipJson(buf)
    : JSON.parse(new TextDecoder("utf-8").decode(buf));
  payloadCache = parsed as TranscriptPayload;
  return payloadCache;
}

function volumeApiBase(): string {
  const fromEnv = (import.meta.env.VITE_AMRTF_VOLUME_API_BASE as string | undefined)?.trim();
  const base = (fromEnv && fromEnv.length > 0 ? fromEnv : `https://cdn.amec.amrtf.org/volume/${AMRTF_NANPUTUO_COURSE}`).replace(
    /\/$/,
    "",
  );
  return base;
}

async function fetchAmrtfMp3UrlForPage(pageSlug: string): Promise<string | null> {
  const n = Number.parseInt(pageSlug, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const url = `${volumeApiBase()}/${n}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    media?: Array<{ mediaType?: string; src?: string }>;
  };
  const list = data.media;
  if (!Array.isArray(list)) return null;
  for (const m of list) {
    if (m.mediaType === "audio/mpeg" && typeof m.src === "string" && m.src.length > 0) {
      return `${m.src}${AMRTF_MP3_SUFFIX}`;
    }
  }
  return null;
}

function getAmrtfMp3Url(pageSlug: string): Promise<string | null> {
  if (amrtfUrlCache.has(pageSlug)) {
    return Promise.resolve(amrtfUrlCache.get(pageSlug) ?? null);
  }
  let p = amrtfInflight.get(pageSlug);
  if (!p) {
    p = fetchAmrtfMp3UrlForPage(pageSlug).then((url) => {
      amrtfUrlCache.set(pageSlug, url);
      amrtfInflight.delete(pageSlug);
      return url;
    });
    amrtfInflight.set(pageSlug, p);
  }
  return p;
}

function normalizeQ(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

/** 與建置時手抄引文一致：NFC + 去空白 */
function normalizeForMatch(s: string): string {
  return normalizeQ(s.normalize("NFC"));
}

/**
 * 索引內文為繁體；常見簡體字轉成繁體再比對，避免「由闻知诸法」對不到「由聞知諸法」。
 */
function queryToTradVariants(q: string): string[] {
  const n = normalizeForMatch(q);
  const map: Record<string, string> = {
    闻: "聞",
    诸: "諸",
    无: "無",
    义: "義",
    断: "斷",
    恶: "惡",
    恼: "惱",
    总: "總",
    实: "實",
    证: "證",
    说: "說",
    听: "聽",
    见: "見",
    觉: "覺",
    学: "學",
    习: "習",
    门: "門",
    开: "開",
    关: "關",
    东: "東",
    车: "車",
    长: "長",
    张: "張",
    国: "國",
    过: "過",
    还: "還",
    这: "這",
    个: "個",
    们: "們",
    来: "來",
    时: "時",
    问: "問",
    间: "間",
    体: "體",
    会: "會",
    发: "發",
    经: "經",
    书: "書",
    师: "師",
    众: "眾",
    难: "難",
    风: "風",
    龙: "龍",
    马: "馬",
    鸟: "鳥",
    鱼: "魚",
  };
  let mapped = "";
  for (const ch of n) {
    mapped += map[ch] ?? ch;
  }
  const out = new Set<string>([n]);
  if (mapped !== n) out.add(mapped);
  return [...out];
}

function segmentHaystack(seg: FlatSegment): string {
  return normalizeForMatch(seg.quoteText);
}

function audioPlanForSeg(seg: FlatSegment): AudioPlanStep[] {
  if (Array.isArray(seg.audioPlan) && seg.audioPlan.length > 0) return seg.audioPlan;
  return [{ pageSlug: seg.pageSlug, startSec: seg.startSec, endSec: seg.endSec }];
}

function segmentMatches(seg: FlatSegment, variants: string[]): boolean {
  const h = segmentHaystack(seg);
  return variants.some((v) => v.length >= 2 && h.includes(v));
}

type TimeLookup = {
  tapeId?: string;
  pageSlug?: string;
  sec: number;
};

/** 僅 mm:ss（分:秒），不接受 hh:mm:ss */
function parseClockToSec(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(":").map((x) => Number.parseInt(x.trim(), 10));
  if (parts.length !== 2) return null;
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [m, sec] = parts;
  if (sec >= 60) return null;
  return m * 60 + sec;
}

/** 僅 mm:ss：滿 4 位數字時自動插入「:」；已含「:」則整理為兩段 */
function normalizeTimeInputForDisplay(raw: string): string {
  const t = raw.trim();
  if (t.includes(":")) {
    const idx = t.indexOf(":");
    const left = t.slice(0, idx).replace(/\D/g, "");
    const right = t.slice(idx + 1).replace(/\D/g, "").slice(0, 2);
    if (!left && !right) return "";
    return `${left}:${right}`;
  }
  const digits = t.replace(/\D/g, "").slice(0, 4);
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return digits;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function trimHtmlToEndSec(html: string, endSec: number | null): string {
  if (endSec == null) return html;
  const m = html.match(new RegExp(`data-time="${endSec}"`, "i"));
  if (!m || m.index == null) return html;
  const idx = m.index;
  const closeSpan = html.indexOf("</span>", idx);
  if (closeSpan < 0) return html.slice(0, idx);
  return html.slice(0, closeSpan + "</span>".length);
}

function injectSeekLabels(html: string): string {
  return html.replace(
    /<span\b([^>]*\bclass="[^"]*\bseek-to\b[^"]*"[^>]*)><\/span>/gi,
    (_m, attrs: string) => {
      const tm = attrs.match(/\bdata-time="(\d+)"/i);
      const lm = attrs.match(/\bdata-label="([^"]+)"/i);
      const sec = tm ? Number.parseInt(tm[1], 10) : null;
      const label = lm?.[1] ?? (sec != null && Number.isFinite(sec) ? formatTime(sec) : null);
      if (!label) return "";
      return `<span class="transcripts-seek-label" data-time="${sec ?? ""}">[${label}]</span>`;
    },
  );
}

function flashSeekContext(node: HTMLElement): void {
  const sentenceHost =
    node.closest("p") ??
    node.closest("li") ??
    node.closest("blockquote") ??
    node.parentElement;
  if (!sentenceHost) return;
  sentenceHost.classList.add("transcripts-seek-flash");
  window.setTimeout(() => {
    sentenceHost.classList.remove("transcripts-seek-flash");
  }, 1200);
}

function sortByReadingOrder(list: FlatSegment[]): FlatSegment[] {
  return list.slice().sort((a, b) => {
    const pa = Number.parseInt(a.pageSlug, 10);
    const pb = Number.parseInt(b.pageSlug, 10);
    if (pa !== pb) return pa - pb;
    if (a.entryIndex !== b.entryIndex) return a.entryIndex - b.entryIndex;
    return a.id - b.id;
  });
}

function formatSegmentTimeLabel(seg: FlatSegment): string {
  const plan = audioPlanForSeg(seg);
  if (plan.length <= 1) {
    return seg.endSec != null ? `${formatTime(seg.startSec)} – ${formatTime(seg.endSec)}` : `${formatTime(seg.startSec)} 起`;
  }
  const first = plan[0]!;
  const last = plan[plan.length - 1]!;
  const lastEnd = last.endSec != null ? formatTime(last.endSec) : "檔尾";
  return `${first.pageSlug} ${formatTime(first.startSec)} 起 → ${last.pageSlug} ${lastEnd}`;
}

export async function mountLamrimTranscripts(
  root: HTMLElement,
  opts: { onBack: () => void },
): Promise<() => void> {
  root.innerHTML = `
    <div class="transcripts">
      <div class="transcripts-toolbar">
        <button type="button" class="transcripts-back" id="tr-back">返回</button>
        <h1 class="transcripts-title">菩提道次第廣論手抄</h1>
        <div class="transcripts-mode-toggle" role="group" aria-label="查詢模式">
          <button type="button" id="tr-mode-quote" class="transcripts-mode-btn is-active" title="原文查詢" aria-label="原文查詢">文</button>
          <button type="button" id="tr-mode-time" class="transcripts-mode-btn" title="卷數時間查詢" aria-label="卷數時間查詢">時</button>
        </div>
      </div>
      <p class="transcripts-hint" id="tr-hint">輸入手抄<strong>原文</strong>中的一小段（可只打幾個連續字），搜尋對應開示與音檔時間。</p>
      <div class="transcripts-search-row" id="tr-row-quote">
        <input type="search" id="tr-q" class="transcripts-input" placeholder="例如：無上甚深微妙法" autocomplete="off" />
        <button type="button" class="primary" id="tr-search-quote">搜尋</button>
      </div>
      <div class="transcripts-search-row hidden" id="tr-row-time">
        <span class="transcripts-tape-prefix" aria-hidden="true">卷</span>
        <input type="text" id="tr-id-num" class="transcripts-input transcripts-input-id-num" placeholder="數字，例如 9" autocomplete="off" inputmode="numeric" aria-label="卷數" />
        <div class="transcripts-ab-toggle" id="tr-ab-toggle" role="group" aria-label="卷別">
          <button type="button" id="tr-part-a" class="transcripts-mode-btn is-active" aria-label="A 卷">A</button>
          <button type="button" id="tr-part-b" class="transcripts-mode-btn" aria-label="B 卷">B</button>
        </div>
        <input type="text" id="tr-time" class="transcripts-input" placeholder="時間，例如 25:37" autocomplete="off" />
        <button type="button" class="primary" id="tr-search-time">查詢</button>
      </div>
      <div id="tr-status" class="transcripts-status" role="status"></div>
      <div id="tr-results" class="transcripts-results"></div>
      <div id="tr-detail" class="transcripts-detail hidden"></div>
    </div>
  `;

  const btnBack = root.querySelector<HTMLButtonElement>("#tr-back")!;
  const inputQ = root.querySelector<HTMLInputElement>("#tr-q")!;
  const inputIdNum = root.querySelector<HTMLInputElement>("#tr-id-num")!;
  const btnPartA = root.querySelector<HTMLButtonElement>("#tr-part-a")!;
  const btnPartB = root.querySelector<HTMLButtonElement>("#tr-part-b")!;
  const inputTime = root.querySelector<HTMLInputElement>("#tr-time")!;
  const btnSearchQuote = root.querySelector<HTMLButtonElement>("#tr-search-quote")!;
  const btnSearchTime = root.querySelector<HTMLButtonElement>("#tr-search-time")!;
  const btnModeQuote = root.querySelector<HTMLButtonElement>("#tr-mode-quote")!;
  const btnModeTime = root.querySelector<HTMLButtonElement>("#tr-mode-time")!;
  const rowQuote = root.querySelector<HTMLDivElement>("#tr-row-quote")!;
  const rowTime = root.querySelector<HTMLDivElement>("#tr-row-time")!;
  const hintEl = root.querySelector<HTMLParagraphElement>("#tr-hint")!;
  const statusEl = root.querySelector<HTMLDivElement>("#tr-status")!;
  const resultsEl = root.querySelector<HTMLDivElement>("#tr-results")!;
  const detailEl = root.querySelector<HTMLDivElement>("#tr-detail")!;

  let audioEl: HTMLAudioElement | null = null;
  let detachAudioListeners: (() => void) | null = null;
  /** 遞增後可使進行中的多段播放鏈停止 */
  let audioPlayGen = 0;
  let activePlan: AudioPlanStep[] = [];
  let activeStepIndex = -1;
  let playStepAt: ((stepIndex: number, overrideSec?: number, autoPlay?: boolean) => void) | null = null;

  let flatList: FlatSegment[] = [];
  const pageTapeBySlug = new Map<string, string | null>();
  let searchMode: "quote" | "time" = "quote";
  let tapePart: "A" | "B" = "A";

  function segmentMatchesTimeLookup(seg: FlatSegment, q: TimeLookup): boolean {
    const plan = audioPlanForSeg(seg);
    for (const step of plan) {
      const slugOk = q.pageSlug ? step.pageSlug === q.pageSlug : true;
      const tapeOk = q.tapeId ? pageTapeBySlug.get(step.pageSlug) === q.tapeId : true;
      if (!slugOk || !tapeOk) continue;
      if (q.sec < step.startSec) continue;
      if (step.endSec != null && q.sec > step.endSec) continue;
      return true;
    }
    return false;
  }

  function cleanupAudio(): void {
    audioPlayGen++;
    if (detachAudioListeners) {
      detachAudioListeners();
      detachAudioListeners = null;
    }
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();
    }
  }

  async function playSegment(seg: FlatSegment): Promise<void> {
    cleanupAudio();
    const gen = audioPlayGen;
    const plan = audioPlanForSeg(seg);
    activePlan = plan;
    activeStepIndex = -1;
    const slot = detailEl.querySelector<HTMLElement>("#tr-audio-slot");
    if (!slot) return;
    const slotEl = slot;
    const btnToggle = detailEl.querySelector<HTMLButtonElement>("#tr-audio-toggle");
    const seek = detailEl.querySelector<HTMLInputElement>("#tr-audio-seek");
    const timeEl = detailEl.querySelector<HTMLElement>("#tr-audio-time");
    if (!btnToggle || !seek || !timeEl) return;

    let endBoundSec: number | null = null;
    let stepStartSec = 0;

    const setToggleText = () => {
      if (!audioEl) {
        btnToggle.textContent = "播放";
        return;
      }
      btnToggle.textContent = audioEl.paused ? "播放" : "暫停";
    };

    const renderStepTime = () => {
      if (!audioEl || endBoundSec == null) {
        timeEl.textContent = "--:-- / --:--";
        return;
      }
      const current = Math.max(0, audioEl.currentTime - stepStartSec);
      const total = Math.max(0, endBoundSec - stepStartSec);
      seek.max = String(total);
      seek.value = String(Math.min(total, current));
      timeEl.textContent = `${formatTime(Math.floor(current))} / ${formatTime(Math.floor(total))}`;
    };

    seek.addEventListener("input", () => {
      if (!audioEl || endBoundSec == null) return;
      const rel = Number.parseFloat(seek.value);
      if (!Number.isFinite(rel)) return;
      const target = Math.min(endBoundSec, Math.max(stepStartSec, stepStartSec + rel));
      audioEl.currentTime = target;
      renderStepTime();
    });
    btnToggle.addEventListener("click", () => {
      if (!audioEl) return;
      if (audioEl.paused) {
        void audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
      }
      setToggleText();
    });

    const clearStepListeners = () => {
      if (detachAudioListeners) {
        detachAudioListeners();
        detachAudioListeners = null;
      }
    };

    async function runStep(stepIndex: number, overrideSec?: number, autoPlay = false): Promise<void> {
      if (gen !== audioPlayGen) return;
      if (stepIndex >= plan.length) {
        statusEl.textContent = "";
        return;
      }
      const step = plan[stepIndex]!;
      activeStepIndex = stepIndex;
      const isLast = stepIndex === plan.length - 1;
      statusEl.textContent =
        stepIndex === 0 ? "取得音檔位址…" : `接續載入講次 ${step.pageSlug}…`;

      const urlMp3 = await getAmrtfMp3Url(step.pageSlug);
      if (gen !== audioPlayGen) return;
      if (!urlMp3) {
        statusEl.textContent = `無法取得講次 ${step.pageSlug} 對應音檔，請稍後再試或至官網該講次頁面收聽。`;
        return;
      }

      if (stepIndex === 0) {
        slotEl.innerHTML = "";
        audioEl = document.createElement("audio");
        audioEl.controls = false;
        audioEl.className = "transcripts-audio";
        slotEl.appendChild(audioEl);
      }
      if (!audioEl) return;

      clearStepListeners();
      audioEl.src = urlMp3;
      audioEl.load();

      const onMeta = () => {
        if (gen !== audioPlayGen || !audioEl) return;
        stepStartSec = step.startSec;
        endBoundSec = step.endSec ?? (Number.isFinite(audioEl.duration) ? audioEl.duration : null);
        audioEl.currentTime = overrideSec != null ? Math.max(step.startSec, overrideSec) : step.startSec;
        if (autoPlay) {
          void audioEl.play().catch(() => {});
        }
        renderStepTime();
        setToggleText();
        audioEl.removeEventListener("loadedmetadata", onMeta);
      };
      audioEl.addEventListener("loadedmetadata", onMeta);

      if (step.endSec != null) {
        const onTime = () => {
          if (gen !== audioPlayGen || !audioEl) return;
          renderStepTime();
          setToggleText();
          if (audioEl.currentTime >= step.endSec!) {
            audioEl.pause();
            clearStepListeners();
            if (stepIndex + 1 < plan.length) {
              void runStep(stepIndex + 1);
              return;
            }
            statusEl.textContent = "";
          }
        };
        audioEl.addEventListener("timeupdate", onTime);
        detachAudioListeners = () => {
          audioEl?.removeEventListener("timeupdate", onTime);
        };
      } else if (!isLast) {
        const onEnded = () => {
          if (gen !== audioPlayGen || !audioEl) return;
          audioEl.removeEventListener("ended", onEnded);
          renderStepTime();
          setToggleText();
          clearStepListeners();
          void runStep(stepIndex + 1);
        };
        audioEl.addEventListener("ended", onEnded);
        detachAudioListeners = () => {
          audioEl?.removeEventListener("ended", onEnded);
        };
      } else {
        const onTime = () => {
          renderStepTime();
          setToggleText();
        };
        const onPause = () => setToggleText();
        const onPlay = () => setToggleText();
        audioEl.addEventListener("timeupdate", onTime);
        audioEl.addEventListener("pause", onPause);
        audioEl.addEventListener("play", onPlay);
        detachAudioListeners = () => {
          audioEl?.removeEventListener("timeupdate", onTime);
          audioEl?.removeEventListener("pause", onPause);
          audioEl?.removeEventListener("play", onPlay);
        };
      }

      statusEl.textContent = "";
    }

    playStepAt = (stepIndex: number, overrideSec?: number, autoPlay = false) => {
      void runStep(stepIndex, overrideSec, autoPlay);
    };
    await runStep(0);
  }

  function showDetail(seg: FlatSegment): void {
    resultsEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
    const allOrder = sortByReadingOrder(flatList.filter((x) => x.segmentIndex === 0));
    const pidx = allOrder.findIndex((x) => x.id === seg.id);
    const plan = audioPlanForSeg(seg);
    const multi = plan.length > 1;
    const timeLabel = formatSegmentTimeLabel(seg);
    const planHint = multi
      ? ` · 音檔 ${plan.length} 段（${plan.map((s) => s.pageSlug).join("→")}）`
      : "";
    detailEl.dataset.openSegId = String(seg.id);
    detailEl.innerHTML = `
      <div class="transcripts-detail-head">
        <button type="button" id="tr-close-detail">結果列表</button>
        <span class="transcripts-meta">卷 ${seg.tapeId ?? "?"} · ${timeLabel}${planHint} · <a href="${seg.pageUrl}" target="_blank" rel="noopener">逐字稿 ${seg.pageSlug}</a></span>
      </div>
      <div class="transcripts-detail-nav">
        <button type="button" id="tr-prev" ${pidx <= 0 ? "disabled" : ""}>上一段</button>
        <button type="button" id="tr-next" ${pidx < 0 || pidx >= allOrder.length - 1 ? "disabled" : ""}>下一段</button>
      </div>
      <blockquote class="transcripts-quote">${seg.quoteHtml}</blockquote>
      <div class="transcripts-expl" id="tr-expl"></div>
      <div id="tr-audio-slot" class="transcripts-audio-slot"></div>
      <div class="transcripts-player-controls">
        <button type="button" id="tr-audio-toggle">播放</button>
        <input type="range" id="tr-audio-seek" min="0" max="1" step="0.1" value="0" />
        <span id="tr-audio-time" class="transcripts-meta">--:-- / --:--</span>
      </div>
      <div class="transcripts-meta transcripts-cdn-note">音檔經網路自大慈恩譯經基金會 CDN 串流播放。</div>
    `;
    const expl = detailEl.querySelector("#tr-expl")!;
    const mergedHtml =
      seg.explanationHtml +
      (seg.continuationHtml != null && seg.continuationHtml.length > 0 ? seg.continuationHtml : "");
    const lastEndSec = plan.length ? plan[plan.length - 1]!.endSec : seg.endSec;
    expl.innerHTML = injectSeekLabels(trimHtmlToEndSec(mergedHtml, lastEndSec));
    expl.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      const node = target?.closest(".transcripts-seek-label") as HTMLElement | null;
      if (!node) return;
      flashSeekContext(node);
      const secStr = node.getAttribute("data-time");
      if (!secStr) return;
      const sec = Number.parseInt(secStr, 10);
      if (!Number.isFinite(sec) || !activePlan.length || !playStepAt) return;

      let idx = activeStepIndex >= 0 ? activeStepIndex : 0;
      const cur = activePlan[idx];
      const inCur =
        cur != null &&
        sec >= cur.startSec &&
        (cur.endSec == null || sec <= cur.endSec);
      if (!inCur) {
        const found = activePlan.findIndex((s) => sec >= s.startSec && (s.endSec == null || sec <= s.endSec));
        if (found >= 0) idx = found;
      }
      playStepAt(idx, sec, true);
    });
    audioEl = null;

    void playSegment(seg);

    detailEl.querySelector("#tr-close-detail")!.addEventListener("click", () => {
      cleanupAudio();
      detailEl.classList.add("hidden");
      resultsEl.classList.remove("hidden");
    });
    detailEl.querySelector("#tr-prev")!.addEventListener("click", () => {
      if (pidx > 0) showDetail(allOrder[pidx - 1]!);
    });
    detailEl.querySelector("#tr-next")!.addEventListener("click", () => {
      if (pidx >= 0 && pidx < allOrder.length - 1) showDetail(allOrder[pidx + 1]!);
    });
  }

  function renderSearchHits(hits: FlatSegment[]): void {
    statusEl.textContent = hits.length ? `找到 ${hits.length} 筆（可點選檢視開示）` : "找不到包含此原文的段落。";
    resultsEl.innerHTML = "";
    const cap = Math.min(hits.length, 200);
    for (let h = 0; h < cap; h++) {
      const seg = hits[h]!;
      const li = document.createElement("button");
      li.type = "button";
      li.className = "transcripts-hit";
      const preview = seg.quoteText.slice(0, 80) + (seg.quoteText.length > 80 ? "…" : "");
      const timeLabel = formatSegmentTimeLabel(seg);
      li.innerHTML = `<span class="transcripts-hit-meta">卷${seg.tapeId ?? "?"} · ${timeLabel}</span><span class="transcripts-hit-q">${preview}</span>`;
      li.addEventListener("click", () => showDetail(seg));
      resultsEl.appendChild(li);
    }
    if (hits.length > 200) statusEl.textContent += "（僅顯示前 200 筆，請縮小關鍵字）";
  }

  function runQuoteSearch(): void {
    const variants = queryToTradVariants(inputQ.value).filter((v) => v.length >= 2);
    if (!variants.length) {
      statusEl.textContent = "請至少輸入 2 個字（不含空白）。";
      resultsEl.innerHTML = "";
      return;
    }
    renderSearchHits(flatList.filter((s) => segmentMatches(s, variants)));
  }

  function runTimeSearch(): void {
    const digits = inputIdNum.value.replace(/\D+/g, "");
    const n = Number.parseInt(digits, 10);
    const sec = parseClockToSec(inputTime.value);
    if (!Number.isFinite(n) || n <= 0 || sec == null) {
      statusEl.textContent = "請輸入有效數字與時間，例如 卷 9 + A + 25:37。";
      resultsEl.innerHTML = "";
      return;
    }
    renderSearchHits(flatList.filter((s) => segmentMatchesTimeLookup(s, { tapeId: `${n}${tapePart}`, sec })));
  }

  function setTapePart(part: "A" | "B"): void {
    tapePart = part;
    btnPartA.classList.toggle("is-active", part === "A");
    btnPartB.classList.toggle("is-active", part === "B");
  }

  function setSearchMode(mode: "quote" | "time"): void {
    searchMode = mode;
    const quoteOn = mode === "quote";
    rowQuote.classList.toggle("hidden", !quoteOn);
    rowTime.classList.toggle("hidden", quoteOn);
    btnModeQuote.classList.toggle("is-active", quoteOn);
    btnModeTime.classList.toggle("is-active", !quoteOn);
    hintEl.innerHTML = quoteOn
      ? '輸入手抄<strong>原文</strong>中的一小段（可只打幾個連續字），搜尋對應開示與音檔時間。'
      : '輸入<strong>卷數（數字）+ A/B + 時間</strong>（例如：9、A、25:37）查詢段落與音檔。';
  }

  btnBack.addEventListener("click", () => {
    cleanupAudio();
    opts.onBack();
  });
  btnModeQuote.addEventListener("click", () => setSearchMode("quote"));
  btnModeTime.addEventListener("click", () => setSearchMode("time"));
  btnPartA.addEventListener("click", () => setTapePart("A"));
  btnPartB.addEventListener("click", () => setTapePart("B"));
  btnSearchQuote.addEventListener("click", () => runQuoteSearch());
  btnSearchTime.addEventListener("click", () => runTimeSearch());
  inputQ.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runQuoteSearch();
  });
  inputIdNum.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTimeSearch();
  });
  inputIdNum.addEventListener("input", () => {
    const digits = inputIdNum.value.replace(/\D+/g, "").slice(0, 3);
    if (digits !== inputIdNum.value) inputIdNum.value = digits;
  });
  inputTime.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTimeSearch();
  });
  inputTime.addEventListener("input", () => {
    const v = normalizeTimeInputForDisplay(inputTime.value);
    if (v !== inputTime.value) inputTime.value = v;
  });
  setSearchMode(searchMode);

  statusEl.textContent = "載入索引中…";
  try {
    const data = await loadPayload();
    flatList = data.flatSegments;
    pageTapeBySlug.clear();
    for (const p of data.pages) {
      pageTapeBySlug.set(p.slug, p.tapeId ?? null);
    }
    statusEl.textContent = `已載入 ${data.pages.length} 頁、${flatList.length} 個音檔段落。`;
  } catch (e) {
    statusEl.textContent = String(e);
  }

  return () => {
    cleanupAudio();
    payloadCache = null;
    amrtfUrlCache.clear();
    amrtfInflight.clear();
  };
}
