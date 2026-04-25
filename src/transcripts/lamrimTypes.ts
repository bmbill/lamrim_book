export type TranscriptEntry = {
  quoteText: string;
  quoteHtml: string;
  explanationHtml: string;
  explanationText: string;
};

export type TranscriptPage = {
  slug: string;
  pageUrl: string;
  tapeId: string | null;
  entries: TranscriptEntry[];
  error?: string;
};

/** 單一講次音檔上的播放區間；多筆依序串接即完整「手抄一則」對應錄音 */
export type AudioPlanStep = {
  pageSlug: string;
  startSec: number;
  endSec: number | null;
};

export type SourceKey = "nanputuo" | "fengshan";

/** 鳳山寺版每段皆含原卷（第N卷 MM:SS）對照，用於以原錄音卷次作時間查詢 */
export type OriginalTapeRef = {
  volume: number;
  startSec: number;
};

export type FlatSegment = {
  id: number;
  tapeId: string | null;
  pageSlug: string;
  pageUrl: string;
  entryIndex: number;
  segmentIndex: number;
  quoteText: string;
  quoteHtml: string;
  explanationHtml: string;
  explanationText: string;
  /** 跨講次時，下一講次頁中、下一則 blockquote 之前的釋文 HTML */
  continuationHtml?: string;
  continuationText?: string;
  /** 摘要：第一支音檔起點 */
  startSec: number;
  /** 摘要：最後一支音檔終點（null ＝ 播至該檔結尾） */
  endSec: number | null;
  audioPlan: AudioPlanStep[];
  /** 來源：未填視為 "nanputuo"（向後相容舊 payload） */
  sourceKey?: SourceKey;
  /** 鳳山寺直接給定音檔 URL；南普陀走 AMRTF API，可留空 */
  audioUrl?: string;
  /** 鳳山寺原卷對照（段落起點） */
  originalTape?: OriginalTapeRef;
  /** 鳳山寺原卷對照（段落終點：取下段 originalTape；跨卷時以音檔 duration 推算） */
  endOriginalTape?: OriginalTapeRef;
  /** 鳳山寺講次 slug（與 pageSlug 相同，語義別名） */
  lessonSlug?: string;
  /** 鳳山寺講次標題（lesson 01 =「一、要旨總說」） */
  lessonTitle?: string;
};

/** 鳳山寺：一講次 MP3 對應之原錄音卷範圍（引自 blisswisdom 索引表第 3 欄） */
export type LessonTapeRange = {
  lessonSlug: string;
  startTape: number;
  startTapeSec: number;
  endTape: number;
  endTapeSec: number;
};

export type KepanSection = {
  index: number;
  name: string;
  group: number;
  paraStart: number;
  paraEnd: number;
};

export type KepanGroup = {
  index: number;
  name: string;
  sectionIndexes: number[];
};

export type KepanPayload = {
  builtAt: string;
  source: string;
  groups: KepanGroup[];
  sections: KepanSection[];
  /** segment id → section index, 分兩版 */
  assignments: {
    nanputuo: Record<string, number>;
    fengshan: Record<string, number>;
  };
};

export type TranscriptPayload = {
  builtAt: string;
  source: string;
  pages: TranscriptPage[];
  flatSegments: FlatSegment[];
  /** 未填視為 "nanputuo"（向後相容） */
  sourceKey?: SourceKey;
  /** 鳳山寺用；索引頁提供之講次→原卷範圍 */
  lessonTapeRanges?: LessonTapeRange[];
};
