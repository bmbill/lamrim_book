/** 書籍目錄與「正文起始 PDF 頁」對照（皆為 1-based PDF 頁碼） */

export type BookKind = 'lamrim_main' | 'nanputuo_lr' | 'nanshan_lay' | 'nanshan_vinaya';

export interface BookItem {
  id: string;
  kind: BookKind;
  title: string;
  /** 相對於網站根目錄，例如 pdfs/xxx.pdf */
  pdfPath: string;
  /** 正文第 1 頁對應的 PDF 頁碼 */
  bodyStartPdfPage: number;
  /** 南山 1991 開示：每個 PDF 頁含兩個正文頁（左／右） */
  twoBodyPagesPerPdfPage?: boolean;
  /** 南普陀手抄用：冊號 1–20 */
  volume?: number;
}

/** 南普陀版手抄檔名：LR01 … LR20 */
function lrPath(vol: number): string {
  const n = String(vol).padStart(2, '0');
  return `pdfs/南普陀版手抄LR${n}-2016.pdf`;
}

const VINAYA_FILES: string[] = [
  'pdfs/Nanshan_Vinaya1991-book01-01A-08B.pdf',
  'pdfs/Nanshan_Vinaya1991-book02-09A-16B.pdf',
  'pdfs/Nanshan_Vinaya1991-book03-17A-24B.pdf',
  'pdfs/Nanshan_Vinaya1991-book04-25A-32B.pdf',
  'pdfs/Nanshan_Vinaya1991-book05-33A-40B.pdf',
  'pdfs/Nanshan_Vinaya1991-book06-41A-48B.pdf',
  'pdfs/Nanshan_Vinaya1991-book07-49A-56B.pdf',
  'pdfs/Nanshan_Vinaya1991-book08-57A-64B.pdf',
  'pdfs/Nanshan_Vinaya1991-book09-65A-72B.pdf',
  'pdfs/Nanshan_Vinaya1991-book10-73A-80B.pdf',
];

export const LAMRIM_MAIN: BookItem = {
  id: 'lamrim_main',
  kind: 'lamrim_main',
  title: '菩提道次第廣論',
  pdfPath: 'pdfs/菩提道次第廣論.pdf',
  bodyStartPdfPage: 23,
};

export const NANSHAN_LAY: BookItem = {
  id: 'nanshan_lay',
  kind: 'nanshan_lay',
  title: '南山律在家備覽略編',
  pdfPath: 'pdfs/南山律在家備覽略編.pdf',
  bodyStartPdfPage: 17,
};

export function nanputuoVolumeId(volume: number): string {
  return `nanputuo_lr_${volume}`;
}

export function nanshanVinayaBookId(book: number): string {
  return `nanshan_vinaya_${book}`;
}

export function nanputuoVolumes(): BookItem[] {
  return Array.from({ length: 20 }, (_, i) => {
    const volume = i + 1;
    return {
      id: `nanputuo_lr_${volume}`,
      kind: 'nanputuo_lr',
      title: `南普陀版手抄 第 ${volume} 冊`,
      pdfPath: lrPath(volume),
      bodyStartPdfPage: 9,
      volume,
    };
  });
}

export function nanshanVinayaBooks(): BookItem[] {
  return VINAYA_FILES.map((pdfPath, i) => ({
    id: `nanshan_vinaya_${i + 1}`,
    kind: 'nanshan_vinaya',
    title: `南山律開示 第 ${i + 1} 冊（1991）`,
    pdfPath,
    bodyStartPdfPage: 6,
    twoBodyPagesPerPdfPage: true,
    volume: i + 1,
  }));
}

export function resolvePdfUrl(pdfPath: string): string {
  if (/^https?:\/\//i.test(pdfPath)) return pdfPath;
  const base = import.meta.env.BASE_URL || '/';
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = pdfPath.replace(/^\//, '');
  const path = `${b}/${p}`.replace(/\/+/g, '/');
  return path.startsWith('/') ? path : `/${path}`;
}

/** 正文頁（1-based）→ PDF 頁 */
export function bodyPageToPdfPage(item: BookItem, bodyPage: number): number {
  if (bodyPage < 1) return 1;
  const start = item.bodyStartPdfPage;
  if (item.twoBodyPagesPerPdfPage) {
    return start + Math.floor((bodyPage - 1) / 2);
  }
  return start + (bodyPage - 1);
}

/** 目前 PDF 頁對應的「正文頁」顯示用（1-based）；雙正文／頁時取該 PDF 頁的第一個正文頁 */
export function pdfPageToBodyPage(item: BookItem, pdfPage: number): number {
  const p = Math.max(1, Math.floor(pdfPage));
  const start = item.bodyStartPdfPage;
  if (p < start) return 1;
  if (item.twoBodyPagesPerPdfPage) {
    return 2 * (p - start) + 1;
  }
  return p - start + 1;
}

/** 由「冊內正文頁」反查（南普陀）：PDF 第 9 頁 = 冊內正文第 1 頁 */
export function nanputuoBodyToPdfPage(bodyInVolume: number): number {
  if (bodyInVolume < 1) return 1;
  return 9 + (bodyInVolume - 1);
}
