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
};

export type TranscriptPayload = {
  builtAt: string;
  source: string;
  pages: TranscriptPage[];
  flatSegments: FlatSegment[];
};
