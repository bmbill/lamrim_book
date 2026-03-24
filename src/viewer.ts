import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { BookItem } from './books';
import { resolvePdfUrl } from './books';

// Vite：以 ?url 取得 worker 位址，離線 PWA 可正常載入
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

let docCache: PDFDocumentProxy | null = null;
let docCacheUrl: string | null = null;

export async function loadDocument(item: BookItem): Promise<PDFDocumentProxy> {
  const url = resolvePdfUrl(item.pdfPath);
  if (docCache && docCacheUrl === url) return docCache;
  if (docCache) {
    await docCache.destroy();
    docCache = null;
    docCacheUrl = null;
  }
  const loading = pdfjsLib.getDocument({ url, disableRange: false, disableStream: false });
  docCache = await loading.promise;
  docCacheUrl = url;
  return docCache;
}

export function destroyDocument(): void {
  cancelInFlightPdfRenders();
  if (docCache) {
    void docCache.destroy();
    docCache = null;
    docCacheUrl = null;
  }
}

type PdfRenderTask = { cancel: () => void; promise: Promise<void> };

/** 上一輪尚未完成的 render，避免快速縮放時多個 render 同寫一張 canvas 造成破圖 */
let inFlightRenderTasks: PdfRenderTask[] = [];

function cancelInFlightPdfRenders(): void {
  for (const t of inFlightRenderTasks) {
    try {
      t.cancel();
    } catch {
      /* ignore */
    }
  }
  inFlightRenderTasks = [];
}

function isRenderingCancelled(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'RenderingCancelledException'
  );
}

export async function renderPages(
  doc: PDFDocumentProxy,
  pageNums: number[],
  canvases: HTMLCanvasElement[],
  scale: number,
): Promise<void> {
  cancelInFlightPdfRenders();

  try {
    /** 光柵解析度上限；3x 螢幕仍維持較銳利（PDF 經 canvas 繪製，非向量即時放大） */
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (let i = 0; i < pageNums.length; i++) {
      const p = pageNums[i];
      const canvas = canvases[i];
      if (!canvas || p < 1 || p > doc.numPages) continue;
      const page: PDFPageProxy = await doc.getPage(p);
      const vp = page.getViewport({ scale: scale * dpr });
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = page.render({ canvasContext: ctx, viewport: vp });
      inFlightRenderTasks.push(renderTask);
      try {
        await renderTask.promise;
      } catch (e) {
        if (isRenderingCancelled(e)) return;
        throw e;
      }
      canvas.style.width = `${vp.width / dpr}px`;
      canvas.style.height = `${vp.height / dpr}px`;
    }
  } finally {
    inFlightRenderTasks = [];
  }
}

/** contain：整頁塞進視窗；fitWidth：以寬度撐滿（高可捲動，適合手機） */
export type FitMode = 'contain' | 'fitWidth';

export function fitScale(
  doc: PDFDocumentProxy,
  pageNums: number[],
  containerW: number,
  containerH: number,
  mode: FitMode = 'contain',
): Promise<number> {
  return (async () => {
    let maxW = 0;
    let maxH = 0;
    for (const p of pageNums) {
      if (p < 1 || p > doc.numPages) continue;
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      maxW += vp.width;
      maxH = Math.max(maxH, vp.height);
    }
    if (maxW === 0 || maxH === 0) return 1;
    const gap = 0;
    const pad = 16;
    const sx = (containerW - pad - gap) / maxW;
    const sy = (containerH - pad) / maxH;
    if (mode === 'fitWidth') {
      return Math.max(0.25, Math.min(sx, 2.5));
    }
    return Math.max(0.25, Math.min(sx, sy, 2.5));
  })();
}

export function formatStatus(
  _item: BookItem,
  pdfPage: number,
  numPages: number,
  spread: boolean,
): string {
  const end = spread && pdfPage < numPages ? pdfPage + 1 : pdfPage;
  if (spread && end !== pdfPage) {
    return `第 ${pdfPage}–${end} / ${numPages} 頁`;
  }
  return `第 ${pdfPage} / ${numPages} 頁`;
}
