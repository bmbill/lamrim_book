import type { AudioPlanStep, FlatSegment, LessonTapeRange, SourceKey, TranscriptPayload } from "./lamrimTypes";
import {
  ALL_SOURCES,
  FENGSHAN_SOURCE,
  NANPUTUO_SOURCE,
  fengshanFindByOriginalTape,
  sourceOf,
  type TranscriptSourceConfig,
} from "./sources";

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

/** 南普陀手抄稿於 AMEC 的課程代碼 */
const AMRTF_NANPUTUO_COURSE = "B000027";
const AMRTF_MP3_SUFFIX = "-48kHz-64kbs";

const amrtfUrlCache = new Map<string, string | null>();
const amrtfInflight = new Map<string, Promise<string | null>>();

/** 每個 source 一份 payload 快取 */
const payloadCache = new Map<SourceKey, TranscriptPayload>();

async function gunzipJson(buf: ArrayBuffer): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("此瀏覽器不支援 gzip 解壓（DecompressionStream），請改用 Chrome／Edge／Safari 較新版本。");
  }
  const ds = new DecompressionStream("gzip");
  const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  return JSON.parse(out) as unknown;
}

async function loadPayloadFor(source: TranscriptSourceConfig): Promise<TranscriptPayload> {
  const cached = payloadCache.get(source.key);
  if (cached) return cached;
  const url = resolveDataUrl(source.dataPath);
  let res: Response;
  try {
    // 不指定 cache 模式：交給 browser HTTP cache + Service Worker（StaleWhileRevalidate）
    // 讓索引能跨頁面 reload 重用，避免 2.5MB 每次重抓；新版會在背景靜默更新
    res = await fetch(url);
  } catch (e) {
    const hint =
      "請確認 npm run dev 已啟動且對應的 .json.gz 存在；若曾用 PWA／preview 開過本站，請開發者工具 → Application → Service Workers → Unregister 後強制重新整理。";
    throw new Error(`無法連線載入 ${source.title} 索引 ${url} — ${String(e)}。${hint}`);
  }
  if (!res.ok) throw new Error(`無法載入 ${source.title} 索引：HTTP ${res.status}（${url}）`);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const looksLikeGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  const parsed = (looksLikeGzip
    ? await gunzipJson(buf)
    : JSON.parse(new TextDecoder("utf-8").decode(buf))) as TranscriptPayload;
  // 確保 sourceKey 正確（舊版 payload 可能缺）
  if (!parsed.sourceKey) parsed.sourceKey = source.key;
  for (const s of parsed.flatSegments) {
    if (!s.sourceKey) s.sourceKey = source.key;
  }
  payloadCache.set(source.key, parsed);
  return parsed;
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

async function resolveAudioUrlForStep(seg: FlatSegment, _step: AudioPlanStep): Promise<string | null> {
  if (seg.sourceKey === "fengshan") {
    return seg.audioUrl ?? null;
  }
  return await getAmrtfMp3Url(_step.pageSlug);
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
    闻: "聞", 诸: "諸", 无: "無", 义: "義", 断: "斷", 恶: "惡", 恼: "惱",
    总: "總", 实: "實", 证: "證", 说: "說", 听: "聽", 见: "見", 觉: "覺",
    学: "學", 习: "習", 门: "門", 开: "開", 关: "關", 东: "東", 车: "車",
    长: "長", 张: "張", 国: "國", 过: "過", 还: "還", 这: "這", 个: "個",
    们: "們", 来: "來", 时: "時", 问: "問", 间: "間", 体: "體", 会: "會",
    发: "發", 经: "經", 书: "書", 师: "師", 众: "眾", 难: "難", 风: "風",
    龙: "龍", 马: "馬", 鸟: "鳥", 鱼: "魚",
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

type NanputuoTimeLookup = {
  tapeId: string;
  sec: number;
};

/** 接受 mm:ss 或 h:mm:ss（鳳山寺原卷時間偶有超過 60 分鐘） */
function parseClockToSec(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(":").map((x) => Number.parseInt(x.trim(), 10));
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, sec] = parts;
    if (sec >= 60) return null;
    return m * 60 + sec;
  }
  const [h, m, sec] = parts;
  if (m >= 60 || sec >= 60) return null;
  return h * 3600 + m * 60 + sec;
}

/**
 * 接受 mm:ss 或 h:mm:ss；使用者輸入時不阻擋多段「:」，
 * 只做字元清理與長度截斷，交由 parseClockToSec 最終驗證。
 */
function normalizeTimeInputForDisplay(raw: string): string {
  const t = raw.trim();
  if (t.includes(":")) {
    const parts = t.split(":");
    if (parts.length === 2) {
      const left = parts[0]!.replace(/\D/g, "");
      const right = parts[1]!.replace(/\D/g, "").slice(0, 2);
      if (!left && !right) return "";
      return `${left}:${right}`;
    }
    if (parts.length === 3) {
      const h = parts[0]!.replace(/\D/g, "");
      const m = parts[1]!.replace(/\D/g, "").slice(0, 2);
      const s = parts[2]!.replace(/\D/g, "").slice(0, 2);
      return `${h}:${m}:${s}`;
    }
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

function sortByReadingOrderWithin(source: SourceKey, list: FlatSegment[]): FlatSegment[] {
  return list
    .filter((x) => (x.sourceKey ?? "nanputuo") === source)
    .slice()
    .sort((a, b) => {
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

const ICON_PLAY =
  '<svg class="transcripts-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg class="transcripts-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>';
const ICON_LOOP =
  '<svg class="transcripts-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
const ICON_VOL_HIGH =
  '<svg class="transcripts-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const ICON_VOL_MUTE =
  '<svg class="transcripts-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

const VOLUME_STORAGE_KEY = "tr-audio-volume";

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    const v = raw == null ? NaN : Number.parseFloat(raw);
    if (!Number.isFinite(v)) return 1;
    return Math.min(1, Math.max(0, v));
  } catch {
    return 1;
  }
}

function writeStoredVolume(v: number): void {
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function sourceBadgeHtml(seg: FlatSegment): string {
  const src = sourceOf(seg);
  const cls = src.key === "fengshan" ? "transcripts-source-badge is-fengshan" : "transcripts-source-badge is-nanputuo";
  return `<span class="${cls}">${src.title}</span>`;
}

export async function mountLamrimTranscripts(
  root: HTMLElement,
  opts: { onBack: () => void; openSeg?: { source: SourceKey; id: number } },
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
      <p class="transcripts-hint" id="tr-hint">輸入手抄<strong>原文</strong>中的一小段（可只打幾個連續字），同時搜尋南普陀版與鳳山寺版。</p>
      <div class="transcripts-search-row" id="tr-row-quote">
        <input type="search" id="tr-q" class="transcripts-input" placeholder="例如：無上甚深微妙法" autocomplete="off" />
        <button type="button" class="primary" id="tr-search-quote">搜尋</button>
      </div>
      <div class="transcripts-search-row hidden" id="tr-row-time">
        <div class="transcripts-source-toggle" id="tr-source-toggle" role="group" aria-label="來源版本">
          <button type="button" id="tr-src-np" class="transcripts-mode-btn is-active" aria-label="南普陀版">南普陀</button>
          <button type="button" id="tr-src-fs" class="transcripts-mode-btn" aria-label="鳳山寺版">鳳山寺</button>
        </div>
        <span class="transcripts-tape-prefix" id="tr-tape-prefix" aria-hidden="true">卷</span>
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
  const abToggle = root.querySelector<HTMLDivElement>("#tr-ab-toggle")!;
  const tapePrefix = root.querySelector<HTMLSpanElement>("#tr-tape-prefix")!;
  const btnSrcNp = root.querySelector<HTMLButtonElement>("#tr-src-np")!;
  const btnSrcFs = root.querySelector<HTMLButtonElement>("#tr-src-fs")!;
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

  /** 所有段落（南普陀 + 鳳山寺） */
  let flatList: FlatSegment[] = [];
  /** 以 "${source}:${slug}" 為鍵，值為該頁卷號（僅南普陀用） */
  const pageTapeBySlug = new Map<string, string | null>();
  /** 鳳山寺講次→原卷範圍 */
  let fengshanRanges: LessonTapeRange[] = [];
  let searchMode: "quote" | "time" = "quote";
  let tapePart: "A" | "B" = "A";
  let timeSource: SourceKey = "nanputuo";

  function nanputuoMatchesTimeLookup(seg: FlatSegment, q: NanputuoTimeLookup): boolean {
    if ((seg.sourceKey ?? "nanputuo") !== "nanputuo") return false;
    const plan = audioPlanForSeg(seg);
    for (const step of plan) {
      const tapeOk = pageTapeBySlug.get(`nanputuo:${step.pageSlug}`) === q.tapeId;
      if (!tapeOk) continue;
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

  async function playSegment(seg: FlatSegment, initialOverrideSec?: number): Promise<void> {
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
    const btnLoop = detailEl.querySelector<HTMLButtonElement>("#tr-audio-loop");
    const btnMute = detailEl.querySelector<HTMLButtonElement>("#tr-audio-mute");
    const volSlider = detailEl.querySelector<HTMLInputElement>("#tr-audio-volume");
    if (!btnToggle || !seek || !timeEl || !btnLoop || !btnMute || !volSlider) return;

    let endBoundSec: number | null = null;
    let stepStartSec = 0;
    let loopEnabled = false;
    let storedVolume = readStoredVolume();
    let mutedBeforeZero = storedVolume > 0 ? storedVolume : 1;
    volSlider.value = String(storedVolume);

    const setToggleText = () => {
      const paused = !audioEl || audioEl.paused;
      btnToggle.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
      btnToggle.setAttribute("aria-label", paused ? "播放" : "暫停");
      btnToggle.setAttribute("title", paused ? "播放" : "暫停");
    };
    const setMuteIcon = () => {
      const effective = audioEl ? audioEl.volume : storedVolume;
      const muted = effective <= 0;
      btnMute.innerHTML = muted ? ICON_VOL_MUTE : ICON_VOL_HIGH;
      btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
      btnMute.setAttribute("aria-label", muted ? "取消靜音" : "靜音");
      btnMute.setAttribute("title", muted ? "取消靜音" : "靜音");
    };
    const applyVolume = (v: number, persist = true) => {
      const clamped = Math.min(1, Math.max(0, v));
      if (audioEl) audioEl.volume = clamped;
      storedVolume = clamped;
      if (clamped > 0) mutedBeforeZero = clamped;
      if (persist) writeStoredVolume(clamped);
      if (Number.parseFloat(volSlider.value) !== clamped) volSlider.value = String(clamped);
      setMuteIcon();
    };
    setMuteIcon();
    setToggleText();

    volSlider.addEventListener("input", () => {
      const v = Number.parseFloat(volSlider.value);
      if (Number.isFinite(v)) applyVolume(v);
    });
    btnMute.addEventListener("click", () => {
      if (storedVolume > 0) applyVolume(0);
      else applyVolume(mutedBeforeZero > 0 ? mutedBeforeZero : 1);
    });
    /**
     * 判斷此 plan 是否能用 <audio loop> 原生重播：
     *   單段 + 播到檔尾（step.endSec 為 null）即可；行動裝置最省事可靠。
     *   有 endSec 的段落仍以 seek 回起點方式手動 loop，不重設 src，
     *   藉此保留使用者初始點擊帶來的播放授權。
     */
    const canUseNativeLoop = () =>
      plan.length === 1 && plan[0]!.endSec == null;

    const applyLoopToAudio = () => {
      if (!audioEl) return;
      audioEl.loop = loopEnabled && canUseNativeLoop();
    };

    btnLoop.addEventListener("click", () => {
      loopEnabled = !loopEnabled;
      btnLoop.setAttribute("aria-pressed", loopEnabled ? "true" : "false");
      btnLoop.classList.toggle("is-active", loopEnabled);
      btnLoop.setAttribute("title", loopEnabled ? "重複播放：開" : "重複播放：關");
      applyLoopToAudio();
    });

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

      const urlMp3 = await resolveAudioUrlForStep(seg, step);
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
        audioEl.volume = storedVolume;
        applyLoopToAudio();
        if (autoPlay) {
          void audioEl.play().catch(() => {});
        }
        renderStepTime();
        setToggleText();
        setMuteIcon();
        audioEl.removeEventListener("loadedmetadata", onMeta);
      };
      audioEl.addEventListener("loadedmetadata", onMeta);

      if (step.endSec != null) {
        const onTime = () => {
          if (gen !== audioPlayGen || !audioEl) return;
          renderStepTime();
          setToggleText();
          if (audioEl.currentTime >= step.endSec!) {
            if (stepIndex + 1 < plan.length) {
              audioEl.pause();
              clearStepListeners();
              void runStep(stepIndex + 1);
              return;
            }
            if (loopEnabled && plan.length === 1) {
              // 同一 src 倒回起點再播，避免重載 src 失去行動裝置的播放授權
              audioEl.currentTime = stepStartSec;
              void audioEl.play().catch(() => {});
              return;
            }
            if (loopEnabled) {
              audioEl.pause();
              clearStepListeners();
              void runStep(0, undefined, true);
              return;
            }
            audioEl.pause();
            clearStepListeners();
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
    await runStep(0, initialOverrideSec, initialOverrideSec != null);
  }

  function showDetail(seg: FlatSegment, initialPlaySec?: number): void {
    resultsEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
    const src = sourceOf(seg);
    const allOrder = sortByReadingOrderWithin(src.key, flatList).filter((x) => x.segmentIndex === 0);
    const pidx = allOrder.findIndex((x) => x.id === seg.id);
    const plan = audioPlanForSeg(seg);
    const multi = plan.length > 1;
    const timeLabel = formatSegmentTimeLabel(seg);
    const planHint = multi
      ? ` · 音檔 ${plan.length} 段（${plan.map((s) => s.pageSlug).join("→")}）`
      : "";
    const pageLabel = src.key === "fengshan"
      ? `<a href="${seg.pageUrl}" target="_blank" rel="noopener">第 ${Number(seg.pageSlug)} 講</a>`
      : `<a href="${seg.pageUrl}" target="_blank" rel="noopener">逐字稿 ${seg.pageSlug}</a>`;
    const lessonTitleHtml =
      src.key === "fengshan" && seg.lessonTitle ? ` · ${seg.lessonTitle}` : "";
    detailEl.dataset.openSegId = String(seg.id);
    const bareMode = opts.openSeg != null;
    const closeLabel = bareMode ? "返回" : "結果列表";
    detailEl.innerHTML = `
      <div class="transcripts-detail-head">
        <button type="button" id="tr-close-detail">${closeLabel}</button>
        <span class="transcripts-meta">${sourceBadgeHtml(seg)} ${src.tapeLabel(seg)} · ${timeLabel}${planHint} · ${pageLabel}${lessonTitleHtml}</span>
      </div>
      <div class="transcripts-detail-nav">
        <button type="button" id="tr-prev" ${pidx <= 0 ? "disabled" : ""}>上一段</button>
        <button type="button" id="tr-next" ${pidx < 0 || pidx >= allOrder.length - 1 ? "disabled" : ""}>下一段</button>
      </div>
      <blockquote class="transcripts-quote">${seg.quoteHtml || "<em class=\"transcripts-no-quote\">（此段無廣論原文引用）</em>"}</blockquote>
      <div class="transcripts-expl" id="tr-expl"></div>
      <div id="tr-audio-slot" class="transcripts-audio-slot"></div>
      <div class="transcripts-player-controls">
        <button type="button" id="tr-audio-toggle" class="transcripts-icon-btn" aria-label="播放" title="播放">${ICON_PLAY}</button>
        <input type="range" id="tr-audio-seek" min="0" max="1" step="0.1" value="0" aria-label="進度" />
        <span id="tr-audio-time" class="transcripts-meta">--:-- / --:--</span>
        <button type="button" id="tr-audio-loop" class="transcripts-icon-btn" aria-label="重複播放" aria-pressed="false" title="重複播放此段">${ICON_LOOP}</button>
        <span class="transcripts-volume" aria-label="音量">
          <button type="button" id="tr-audio-mute" class="transcripts-icon-btn" aria-label="靜音" aria-pressed="false" title="靜音">${ICON_VOL_HIGH}</button>
          <input type="range" id="tr-audio-volume" class="transcripts-volume-input" min="0" max="1" step="0.05" value="1" aria-label="音量滑桿" />
        </span>
      </div>
      <div class="transcripts-meta transcripts-cdn-note">${src.key === "fengshan" ? "音檔由福智之聲／BW Sangha CDN 串流播放。" : "音檔經網路自大慈恩譯經基金會 CDN 串流播放。"}</div>
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

    void playSegment(seg, initialPlaySec);

    detailEl.querySelector("#tr-close-detail")!.addEventListener("click", () => {
      cleanupAudio();
      if (bareMode) {
        opts.onBack();
        return;
      }
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
    const np = hits.filter((s) => (s.sourceKey ?? "nanputuo") === "nanputuo");
    const fs = hits.filter((s) => s.sourceKey === "fengshan");
    statusEl.textContent = hits.length
      ? `找到 ${hits.length} 筆：南普陀 ${np.length} 筆、鳳山寺 ${fs.length} 筆`
      : "找不到包含此原文的段落。";
    resultsEl.innerHTML = "";
    const cap = 200;
    let rendered = 0;
    const renderGroup = (label: string, list: FlatSegment[], cfg: TranscriptSourceConfig): void => {
      if (!list.length) return;
      const header = document.createElement("div");
      header.className = `transcripts-group-header is-${cfg.key}`;
      header.textContent = `${label}（${list.length} 筆）`;
      resultsEl.appendChild(header);
      const take = Math.min(list.length, cap - rendered);
      for (let h = 0; h < take; h++) {
        const seg = list[h]!;
        const li = document.createElement("button");
        li.type = "button";
        li.className = `transcripts-hit is-${cfg.key}`;
        const preview =
          (seg.quoteText.length > 0 ? seg.quoteText : seg.explanationText).slice(0, 80) +
          ((seg.quoteText.length || seg.explanationText.length) > 80 ? "…" : "");
        const timeLabel = formatSegmentTimeLabel(seg);
        li.innerHTML = `<span class="transcripts-hit-meta">${cfg.tapeLabel(seg)} · ${timeLabel}</span><span class="transcripts-hit-q">${preview}</span>`;
        li.addEventListener("click", () => showDetail(seg));
        resultsEl.appendChild(li);
      }
      rendered += take;
    };
    renderGroup("南普陀版", np, NANPUTUO_SOURCE);
    renderGroup("鳳山寺版", fs, FENGSHAN_SOURCE);
    if (hits.length > cap) statusEl.textContent += "（顯示前 200 筆，可縮小關鍵字）";
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
      statusEl.textContent =
        timeSource === "nanputuo"
          ? "請輸入有效卷數與時間，例如 卷 9 + A + 25:37。"
          : "請輸入有效原卷號與時間，例如 原卷 5 + 03:20。";
      resultsEl.innerHTML = "";
      return;
    }
    if (timeSource === "nanputuo") {
      renderSearchHits(flatList.filter((s) => nanputuoMatchesTimeLookup(s, { tapeId: `${n}${tapePart}`, sec })));
      return;
    }
    const hit = fengshanFindByOriginalTape(flatList, fengshanRanges, n, sec);
    if (!hit) {
      renderSearchHits([]);
      statusEl.textContent = `鳳山寺原卷 ${n} 於 ${formatTime(sec)} 沒有對應段落（可能超出目前已上架的 ${pagesCountForSource("fengshan")} 講）。`;
      return;
    }
    renderSearchHits([hit.seg]);
    // 自動進入詳細並以 playSec 起播
    showDetail(hit.seg, hit.playSec);
  }

  function pagesCountForSource(key: SourceKey): number {
    return payloadCache.get(key)?.pages.length ?? 0;
  }

  function setTapePart(part: "A" | "B"): void {
    tapePart = part;
    btnPartA.classList.toggle("is-active", part === "A");
    btnPartB.classList.toggle("is-active", part === "B");
  }

  function setTimeSource(key: SourceKey): void {
    timeSource = key;
    btnSrcNp.classList.toggle("is-active", key === "nanputuo");
    btnSrcFs.classList.toggle("is-active", key === "fengshan");
    const isNp = key === "nanputuo";
    abToggle.classList.toggle("hidden", !isNp);
    tapePrefix.textContent = isNp ? "卷" : "原卷";
    inputIdNum.placeholder = isNp ? "數字，例如 9" : "數字，例如 5";
    hintEl.innerHTML = isNp
      ? '輸入<strong>卷數（數字）+ A/B + 時間</strong>（例如：9、A、25:37）查詢南普陀版段落與音檔。'
      : '輸入<strong>原卷號（第N卷的 N）+ 時間</strong>（例如：5、03:20）查詢鳳山寺版段落與音檔。';
  }

  function setSearchMode(mode: "quote" | "time"): void {
    searchMode = mode;
    const quoteOn = mode === "quote";
    rowQuote.classList.toggle("hidden", !quoteOn);
    rowTime.classList.toggle("hidden", quoteOn);
    btnModeQuote.classList.toggle("is-active", quoteOn);
    btnModeTime.classList.toggle("is-active", !quoteOn);
    if (quoteOn) {
      hintEl.innerHTML = '輸入手抄<strong>原文</strong>中的一小段（可只打幾個連續字），同時搜尋南普陀版與鳳山寺版。';
    } else {
      setTimeSource(timeSource);
    }
  }

  btnBack.addEventListener("click", () => {
    cleanupAudio();
    opts.onBack();
  });
  btnModeQuote.addEventListener("click", () => setSearchMode("quote"));
  btnModeTime.addEventListener("click", () => setSearchMode("time"));
  btnPartA.addEventListener("click", () => setTapePart("A"));
  btnPartB.addEventListener("click", () => setTapePart("B"));
  btnSrcNp.addEventListener("click", () => setTimeSource("nanputuo"));
  btnSrcFs.addEventListener("click", () => setTimeSource("fengshan"));
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

  // Bare mode: 從 kepan（或其他外部路由）帶 openSeg 進來，
  // 只顯示返回鍵＋詳細頁，隱藏查詢介面以避免混淆。
  if (opts.openSeg) {
    const modeToggle = root.querySelector<HTMLDivElement>(".transcripts-mode-toggle");
    modeToggle?.classList.add("hidden");
    hintEl.classList.add("hidden");
    rowQuote.classList.add("hidden");
    rowTime.classList.add("hidden");
  }

  statusEl.textContent = "載入索引中…";
  try {
    const loaded = await Promise.allSettled(ALL_SOURCES.map((s) => loadPayloadFor(s)));
    pageTapeBySlug.clear();
    flatList = [];
    fengshanRanges = [];
    let lessonTotal = 0;
    const errors: string[] = [];
    loaded.forEach((r, i) => {
      const src = ALL_SOURCES[i]!;
      if (r.status === "rejected") {
        errors.push(`${src.title}：${String(r.reason)}`);
        return;
      }
      const data = r.value;
      lessonTotal += data.pages.length;
      for (const p of data.pages) {
        pageTapeBySlug.set(`${src.key}:${p.slug}`, p.tapeId ?? null);
      }
      flatList = flatList.concat(data.flatSegments);
      if (src.key === "fengshan" && Array.isArray(data.lessonTapeRanges)) {
        fengshanRanges = data.lessonTapeRanges;
      }
    });
    statusEl.textContent = errors.length
      ? `部份索引載入失敗：${errors.join("；")}`
      : `已載入 ${lessonTotal} 頁／講、${flatList.length} 個段落（南普陀 + 鳳山寺）。`;

    // 由外部指定 segment（例如從科判頁跳入）則自動開啟該段詳細
    if (opts.openSeg) {
      const want = opts.openSeg;
      const target = flatList.find(
        (s) => (s.sourceKey ?? "nanputuo") === want.source && s.id === want.id,
      );
      if (target) showDetail(target);
    }
  } catch (e) {
    statusEl.textContent = String(e);
  }

  return () => {
    cleanupAudio();
    payloadCache.clear();
    amrtfUrlCache.clear();
    amrtfInflight.clear();
  };
}
