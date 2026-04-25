import type { FlatSegment, LessonTapeRange, SourceKey } from "./lamrimTypes";

/**
 * 手抄來源配置。
 * - NANPUTUO: 南普陀版，AMRTF API 解析音檔、以 卷NNN + A/B + MM:SS 做時間查詢
 * - FENGSHAN: 鳳山寺版，每段 segment 已附 audioUrl（直鏈 MP3）、以 原卷 + MM:SS 做時間查詢
 */
export type TranscriptSourceConfig = {
  key: SourceKey;
  title: string;
  dataPath: string;
  /** 時間查詢 UI 類型 */
  timeInputMode: "tape-ab" | "original-tape";
  /** 顯示段落所屬卷／講次 */
  tapeLabel: (seg: FlatSegment) => string;
  /**
   * 段落時間範圍標籤。
   * - 南普陀：直接用音檔時間（每卷一檔，音檔時間＝卷上時間）
   * - 鳳山寺：用 originalTape／endOriginalTape（每講次一檔但跨數卷，
   *   音檔時間不等於原卷時間，需另外標示卷上的位置）
   * 若 seg 沒有相應欄位（舊資料）則退化回音檔 MM:SS。
   */
  formatTimeLabel: (seg: FlatSegment) => string;
};

function formatMSorHMS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const total = Math.floor(sec);
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function audioRangeLabel(seg: FlatSegment): string {
  return seg.endSec != null
    ? `${formatMSorHMS(seg.startSec)} – ${formatMSorHMS(seg.endSec)}`
    : `${formatMSorHMS(seg.startSec)} 起`;
}

export const NANPUTUO_SOURCE: TranscriptSourceConfig = {
  key: "nanputuo",
  title: "南普陀版",
  dataPath: "data/lamrim-transcripts.json.gz",
  timeInputMode: "tape-ab",
  tapeLabel: (seg) => `卷 ${seg.tapeId ?? "?"}`,
  formatTimeLabel: audioRangeLabel,
};

export const FENGSHAN_SOURCE: TranscriptSourceConfig = {
  key: "fengshan",
  title: "鳳山寺版",
  dataPath: "data/fengshan-transcripts.json.gz",
  timeInputMode: "original-tape",
  tapeLabel: (seg) => {
    const lesson = seg.lessonSlug ?? seg.pageSlug;
    const tape = seg.originalTape ? ` · 原卷 ${seg.originalTape.volume}` : "";
    return `第 ${Number(lesson)} 講${tape}`;
  },
  formatTimeLabel: (seg) => {
    if (!seg.originalTape) return audioRangeLabel(seg);
    const startStr = formatMSorHMS(seg.originalTape.startSec);
    const end = seg.endOriginalTape;
    if (!end) return `${startStr} 起`;
    const endStr = formatMSorHMS(end.startSec);
    if (end.volume !== seg.originalTape.volume) {
      return `${startStr} – 卷${end.volume} ${endStr}`;
    }
    return `${startStr} – ${endStr}`;
  },
};

export const ALL_SOURCES: TranscriptSourceConfig[] = [NANPUTUO_SOURCE, FENGSHAN_SOURCE];

export function sourceOf(seg: FlatSegment): TranscriptSourceConfig {
  if (seg.sourceKey === "fengshan") return FENGSHAN_SOURCE;
  return NANPUTUO_SOURCE;
}

/** 用整數元組比較 (vol, sec) 大小 */
function tapeTuple(vol: number, sec: number): number {
  return vol * 100000 + sec;
}

/**
 * 鳳山寺原卷時間查詢：
 *   1. 先以 lessonTapeRanges（索引頁「第N卷 MM:SS ~ 第M卷 MM:SS」範圍）判定所在講次；
 *      這是最可靠的依據，涵蓋 builder 抓不到段落錨點的卷段（例如 卷5 開頭落在講 04）。
 *   2. 於該講次內，找最後一個 originalTape ≤ 查詢值之段落當作錨點；
 *      同卷則精確推算 playSec = anchor.startSec + (tapeSec − anchor.originalTape.startSec)，
 *      不同卷則以該錨點起點播放（數據限制下之近似）。
 *   3. 若該講次完全無段落錨點，則從講次首段起播。
 *
 * 回傳 null 表示該 (volume, tapeSec) 不在任何已抓取的講次範圍內。
 */
export function fengshanFindByOriginalTape(
  segments: FlatSegment[],
  ranges: LessonTapeRange[],
  volume: number,
  tapeSec: number,
): { seg: FlatSegment; playSec: number } | null {
  const q = tapeTuple(volume, tapeSec);
  let lesson: LessonTapeRange | null = null;
  for (const r of ranges) {
    const s = tapeTuple(r.startTape, r.startTapeSec);
    const e = tapeTuple(r.endTape, r.endTapeSec);
    if (q >= s && q < e) {
      lesson = r;
      break;
    }
  }
  if (!lesson) return null;

  const lessonSegs = segments.filter(
    (x) => x.sourceKey === "fengshan" && x.pageSlug === lesson!.lessonSlug,
  );
  if (!lessonSegs.length) return null;

  let anchor: FlatSegment | null = null;
  let anchorKey = -1;
  for (const s of lessonSegs) {
    if (!s.originalTape) continue;
    const k = tapeTuple(s.originalTape.volume, s.originalTape.startSec);
    if (k > q) continue;
    if (k > anchorKey) {
      anchor = s;
      anchorKey = k;
    }
  }

  if (!anchor) {
    const first = lessonSegs.slice().sort((a, b) => a.startSec - b.startSec)[0]!;
    return { seg: first, playSec: first.startSec };
  }

  let playSec = anchor.startSec;
  if (anchor.originalTape!.volume === volume) {
    playSec = anchor.startSec + Math.max(0, tapeSec - anchor.originalTape!.startSec);
  }
  return { seg: anchor, playSec };
}
