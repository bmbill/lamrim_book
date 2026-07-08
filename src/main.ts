import './style.css';
import {
  LAMRIM_MAIN,
  NANSHAN_LAY,
  bodyPageToPdfPage,
  pdfPageToBodyPage,
  nanputuoVolumeId,
  nanputuoVolumes,
  nanshanVinayaBookId,
  nanshanVinayaBooks,
  resolvePdfUrl,
  type BookItem,
} from './books';
import { destroyDocument, fitScale, formatStatus, loadDocument, renderPages } from './viewer';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { mountLamrimTranscripts } from './transcripts/lamrim';
import { mountKepan } from './transcripts/kepan';
import type { SourceKey } from './transcripts/lamrimTypes';

const BOOKS: BookItem[] = [
  LAMRIM_MAIN,
  ...nanputuoVolumes(),
  NANSHAN_LAY,
  ...nanshanVinayaBooks(),
];

const byId = new Map(BOOKS.map((b) => [b.id, b]));

const app = document.querySelector<HTMLDivElement>('#app')!;

function getFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function exitFullscreenCompat(): Promise<void> {
  const doc = document as Document & { webkitExitFullscreen?: () => void | Promise<void> };
  if (typeof document.exitFullscreen === 'function') {
    await Promise.resolve(document.exitFullscreen());
  } else {
    await Promise.resolve(doc.webkitExitFullscreen?.());
  }
}

async function requestFullscreenCompat(el: HTMLElement): Promise<void> {
  const node = el as HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };
  if (typeof el.requestFullscreen === 'function') {
    await Promise.resolve(el.requestFullscreen());
  } else {
    await Promise.resolve(node.webkitRequestFullscreen?.call(el));
  }
}

/**
 * 閱讀區 #stage-wrap 的捲動視窗尺寸（client 內框）。contain 應對齊「配置給 PDF 的區域」，若改用 visualViewport
 * 與元素的交集，在直向手機上常只剩可視帶的一條高度，PDF 會被算得過小、浮在大片黑底中央。
 */
function readingStageFitSize(el: HTMLElement): { w: number; h: number } {
  const r = el.getBoundingClientRect();
  const w = Math.max(32, el.clientWidth > 0 ? el.clientWidth : r.width);
  const h = Math.max(32, el.clientHeight > 0 ? el.clientHeight : r.height);
  return { w, h };
}

/** 與 index.html 一致；用於 iOS 聚焦輸入後短暫限制縮放以還原整頁比例 */
const VIEWPORT_META_DEFAULT = 'width=device-width, initial-scale=1, viewport-fit=cover';

/**
 * 手機聚焦數字框常觸發整頁放大；blur 並短暫限制 maximum-scale 再還原，盡量回到原比例。
 * 閱讀頁「前往」與首頁「開啟」進入閱讀前都會呼叫。
 */
function resetViewportZoomAfterKeyboard(): void {
  const ae = document.activeElement;
  if (ae instanceof HTMLElement) ae.blur();

  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;

  const ua = navigator.userAgent;
  const needsMetaReset = /iP(hone|ad|od)/i.test(ua) || /Android/i.test(ua);
  if (!needsMetaReset) return;

  meta.setAttribute('content', `${VIEWPORT_META_DEFAULT}, maximum-scale=1`);
  window.setTimeout(() => {
    meta.setAttribute('content', VIEWPORT_META_DEFAULT);
  }, 250);
}

const LS_HOME_DISPLAY = 'lamrim-home-display';
/** true：左側點擊為下一頁（左開預設）；滑動為向右下一頁、向左上一頁。false：右側點擊下一頁；滑動為向左下一頁、向右上一頁 */
const LS_READER_NEXT_ON_LEFT = 'lamrim-reader-next-on-left';

const LS_READER_PROGRESS = 'lamrim-reader-progress-v1';
const LS_READER_LAST_BOOK = 'lamrim-reader-last-book';

type StoredReaderProgress = {
  pdfPage: number;
  spread: boolean;
  gotoMode: 'body' | 'pdf';
  /** true：左側點擊下一頁；滑動右向下一頁、左向上一頁。false：右側點擊下一頁；滑動左向下一頁、右向上一頁 */
  nextOnLeft?: boolean;
};

type ReaderProgressMap = Record<string, StoredReaderProgress>;

function readProgressMap(): ReaderProgressMap {
  try {
    const raw = localStorage.getItem(LS_READER_PROGRESS);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return {};
    return o as ReaderProgressMap;
  } catch {
    return {};
  }
}

function readStoredProgress(bookId: string): StoredReaderProgress | null {
  const m = readProgressMap();
  const p = m[bookId];
  if (!p || typeof p.pdfPage !== 'number' || !Number.isFinite(p.pdfPage)) return null;
  const mode = p.gotoMode === 'pdf' ? 'pdf' : 'body';
  return {
    pdfPage: Math.max(1, Math.floor(p.pdfPage)),
    spread: !!p.spread,
    gotoMode: mode,
    nextOnLeft: typeof p.nextOnLeft === 'boolean' ? p.nextOnLeft : undefined,
  };
}

function writeStoredProgress(bookId: string, p: StoredReaderProgress): void {
  try {
    const m = readProgressMap();
    m[bookId] = {
      pdfPage: p.pdfPage,
      spread: p.spread,
      gotoMode: p.gotoMode,
      nextOnLeft: p.nextOnLeft,
    };
    localStorage.setItem(LS_READER_PROGRESS, JSON.stringify(m));
    localStorage.setItem(LS_READER_LAST_BOOK, bookId);
  } catch {
    /* ignore */
  }
}
type HomeDisplayMode = 'list' | 'cards';
type HomeCardFocus = 'none' | 'lamrim' | 'lay';

/** 圖片模式下目前展開的類別（僅 cards 模式使用） */
let homeCardFocus: HomeCardFocus = 'none';

function readHomeDisplayMode(): HomeDisplayMode {
  try {
    return localStorage.getItem(LS_HOME_DISPLAY) === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

function writeHomeDisplayMode(m: HomeDisplayMode): void {
  try {
    localStorage.setItem(LS_HOME_DISPLAY, m);
  } catch {
    /* ignore */
  }
}

function publicAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${relativePath.replace(/^\//, '')}`;
}

type HashRoute =
  | { route: 'home' }
  | { route: 'read'; id: string; initialBody?: number; initialPdf?: number }
  | {
      route: 'transcripts-lamrim';
      openSeg?: { source: SourceKey; id: number };
      from?: 'kepan';
    }
  | { route: 'transcripts-kepan' };

function parseHash(): HashRoute {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h || h === '') return { route: 'home' };
  const qIndex = h.indexOf('?');
  const pathPart = qIndex >= 0 ? h.slice(0, qIndex) : h;
  const queryPart = qIndex >= 0 ? h.slice(qIndex + 1) : '';
  const params = new URLSearchParams(queryPart);
  const bodyRaw = params.get('body');
  const pdfRaw = params.get('pdf');
  const initialBody =
    bodyRaw != null && bodyRaw !== '' ? Number.parseInt(bodyRaw, 10) : undefined;
  const initialPdf =
    pdfRaw != null && pdfRaw !== '' ? Number.parseInt(pdfRaw, 10) : undefined;
  const parts = pathPart.split('/').filter(Boolean);
  if (parts[0] === 'transcripts' && parts[1] === 'kepan') {
    return { route: 'transcripts-kepan' };
  }
  if (parts[0] === 'transcripts' && parts[1] === 'lamrim') {
    const segRaw = params.get('seg');
    let openSeg: { source: SourceKey; id: number } | undefined;
    if (segRaw) {
      const m = segRaw.match(/^(nanputuo|fengshan):(\d+)$/);
      if (m) openSeg = { source: m[1] as SourceKey, id: Number.parseInt(m[2], 10) };
    }
    const fromRaw = params.get('from');
    const from = fromRaw === 'kepan' ? 'kepan' : undefined;
    return { route: 'transcripts-lamrim', openSeg, from };
  }
  const [a, id] = pathPart.split('/');
  if (a === 'read' && id && byId.has(id)) {
    return {
      route: 'read',
      id,
      initialBody: Number.isFinite(initialBody) ? initialBody : undefined,
      initialPdf: Number.isFinite(initialPdf) ? initialPdf : undefined,
    };
  }
  return { route: 'home' };
}

function navigateHome(): void {
  homeCardFocus = 'none';
  window.location.hash = '';
  render();
}

function navigateRead(id: string, opts?: { body?: number; pdf?: number }): void {
  resetViewportZoomAfterKeyboard();
  const q: string[] = [];
  if (opts?.body != null && Number.isFinite(opts.body)) q.push(`body=${Math.floor(opts.body)}`);
  if (opts?.pdf != null && Number.isFinite(opts.pdf)) q.push(`pdf=${Math.floor(opts.pdf)}`);
  const qs = q.length ? `?${q.join('&')}` : '';
  window.location.hash = `#/read/${id}${qs}`;
  render();
}

function render(): void {
  const r = parseHash();
  if (r.route === 'home') {
    transcriptsCleanup?.();
    transcriptsCleanup = null;
    viewerCleanup?.();
    viewerCleanup = null;
    destroyDocument();
    renderHome();
  } else if (r.route === 'transcripts-lamrim') {
    transcriptsCleanup?.();
    transcriptsCleanup = null;
    viewerCleanup?.();
    viewerCleanup = null;
    destroyDocument();
    app.innerHTML = '';
    const fromKepan = r.from === 'kepan';
    // 清掉 seg/from 參數避免歷史紀錄中殘留，下次進頁不自動開啟
    if (window.location.hash.includes('?')) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/transcripts/lamrim`);
    }
    const onBackLamrim = fromKepan
      ? () => {
          window.location.hash = '#/transcripts/kepan';
        }
      : navigateHome;
    void mountLamrimTranscripts(app, {
      onBack: onBackLamrim,
      openSeg: r.openSeg,
    }).then((fn) => {
      transcriptsCleanup = fn;
    });
  } else if (r.route === 'transcripts-kepan') {
    transcriptsCleanup?.();
    transcriptsCleanup = null;
    viewerCleanup?.();
    viewerCleanup = null;
    destroyDocument();
    app.innerHTML = '';
    void mountKepan(app, {
      onBack: navigateHome,
      onOpenSeg: ({ source, id }) => {
        window.location.hash = `#/transcripts/lamrim?seg=${source}:${id}&from=kepan`;
      },
    }).then((fn) => {
      transcriptsCleanup = fn;
    });
  } else {
    transcriptsCleanup?.();
    transcriptsCleanup = null;
    const book = byId.get(r.id);
    if (!book) {
      navigateHome();
      return;
    }
    renderViewer(book, {
      initialBody: r.initialBody,
      initialPdf: r.initialPdf,
    });
  }
}

function lamrimFolderInnerHtml(): string {
  return `
            <div class="sub-block">
              <h3 class="sub-block-title">原文</h3>
              <button type="button" class="book-btn" data-id="${LAMRIM_MAIN.id}">
                ${LAMRIM_MAIN.title}
              </button>
            </div>
            <div class="sub-block">
              <h3 class="sub-block-title">手抄（南普陀 LR01–LR20）</h3>
              <div class="open-row">
                <label>冊 <input type="number" id="lr-vol" min="1" max="20" value="1" /></label>
                <label>正文頁 <input type="number" id="lr-body" min="1" value="1" /></label>
                <button type="button" class="primary" id="lr-open">開啟</button>
              </div>
            </div>`;
}

function layFolderInnerHtml(): string {
  return `
            <div class="sub-block">
              <h3 class="sub-block-title">原文</h3>
              <button type="button" class="book-btn" data-id="${NANSHAN_LAY.id}">
                ${NANSHAN_LAY.title}
              </button>
            </div>
            <div class="sub-block">
              <h3 class="sub-block-title">開示（1991，10 冊）</h3>
              <div class="open-row">
                <label>冊 <input type="number" id="nv-vol" min="1" max="10" value="1" /></label>
                <label>正文頁 <input type="number" id="nv-body" min="1" placeholder="選填，留空從頭" /></label>
                <button type="button" class="primary" id="nv-open">開啟</button>
              </div>
            </div>`;
}

function bindHomeInteractions(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => navigateRead(btn.dataset.id!));
  });

  root.querySelector<HTMLButtonElement>('#lr-open')?.addEventListener('click', () => {
    const vol = Math.floor(Number(root.querySelector<HTMLInputElement>('#lr-vol')!.value));
    const body = Math.floor(Number(root.querySelector<HTMLInputElement>('#lr-body')!.value));
    if (!Number.isFinite(vol) || vol < 1 || vol > 20) {
      alert('冊數請填 1–20');
      return;
    }
    if (!Number.isFinite(body) || body < 1) {
      alert('正文頁請填 1 以上');
      return;
    }
    navigateRead(nanputuoVolumeId(vol), { body });
  });

  root.querySelector<HTMLButtonElement>('#nv-open')?.addEventListener('click', () => {
    const vol = Math.floor(Number(root.querySelector<HTMLInputElement>('#nv-vol')!.value));
    const bodyRaw = root.querySelector<HTMLInputElement>('#nv-body')!.value.trim();
    const body = bodyRaw === '' ? undefined : Math.floor(Number(bodyRaw));
    if (!Number.isFinite(vol) || vol < 1 || vol > 10) {
      alert('冊數請填 1–10');
      return;
    }
    if (body != null && (!Number.isFinite(body) || body < 1)) {
      alert('正文頁請填 1 以上，或留空從頭開啟');
      return;
    }
    navigateRead(nanshanVinayaBookId(vol), body != null ? { body } : undefined);
  });

  root.querySelector<HTMLButtonElement>('#btn-mode-list')?.addEventListener('click', () => {
    writeHomeDisplayMode('list');
    homeCardFocus = 'none';
    render();
  });
  root.querySelector<HTMLButtonElement>('#btn-mode-cards')?.addEventListener('click', () => {
    writeHomeDisplayMode('cards');
    homeCardFocus = 'none';
    render();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-open-card]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.openCard;
      homeCardFocus = k === 'lay' ? 'lay' : 'lamrim';
      render();
    });
  });

  root.querySelector<HTMLButtonElement>('[data-back-card]')?.addEventListener('click', () => {
    homeCardFocus = 'none';
    render();
  });
}

function renderHome(): void {
  const mode = readHomeDisplayMode();
  const listOn = mode === 'list';
  const imgLamrim = publicAssetUrl('banners/lamrim.png');
  const imgLay = publicAssetUrl('banners/nanshan-lay.png');

  let body = '';

  if (mode === 'list') {
    body = `
      <div class="section">
        <details class="book-folder">
          <summary class="book-folder-summary">菩提道次第廣論</summary>
          <div class="book-folder-body">
            ${lamrimFolderInnerHtml()}
          </div>
        </details>
      </div>
      <div class="section">
        <details class="book-folder">
          <summary class="book-folder-summary">南山律在家備覽略編</summary>
          <div class="book-folder-body">
            ${layFolderInnerHtml()}
          </div>
        </details>
      </div>`;
  } else if (homeCardFocus === 'none') {
    body = `
      <div class="section home-banners">
        <button type="button" class="home-banner" data-open-card="lamrim" aria-label="菩提道次第廣論">
          <img src="${imgLamrim}" alt="" loading="lazy" decoding="async" />
        </button>
        <button type="button" class="home-banner" data-open-card="lay" aria-label="南山律在家備覽略編">
          <img src="${imgLay}" alt="" loading="lazy" decoding="async" />
        </button>
      </div>`;
  } else if (homeCardFocus === 'lamrim') {
    body = `
      <div class="section">
        <button type="button" class="book-btn home-back-card" data-back-card>← 返回選書</button>
        <div class="book-folder card-detail-panel">
          <div class="book-folder-body">
            ${lamrimFolderInnerHtml()}
          </div>
        </div>
      </div>`;
  } else {
    body = `
      <div class="section">
        <button type="button" class="book-btn home-back-card" data-back-card>← 返回選書</button>
        <div class="book-folder card-detail-panel">
          <div class="book-folder-body">
            ${layFolderInnerHtml()}
          </div>
        </div>
      </div>`;
  }

  const iconList = `<svg class="home-mode-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></svg>`;
  const iconGallery = `<svg class="home-mode-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const iconTranscripts = `<svg class="home-feature-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v4h4"/><line x1="7" y1="11" x2="13" y2="11"/><line x1="7" y1="14.5" x2="12" y2="14.5"/><circle cx="16.5" cy="17.5" r="2.2"/><line x1="18.2" y1="19.2" x2="20" y2="21"/></svg>`;
  const iconKepan = `<svg class="home-feature-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h4"/><path d="M10 5h10"/><path d="M4 5v14"/><path d="M8 10h3"/><path d="M13 10h7"/><path d="M11 15h3"/><path d="M16 15h4"/></svg>`;

  app.innerHTML = `
    <div class="home">
      <div class="home-header">
        <h1>法音書房</h1>
        <div class="home-toolbar" role="group" aria-label="首頁顯示方式">
          <button type="button" class="home-mode-btn${listOn ? ' is-active' : ''}" id="btn-mode-list" aria-label="條列顯示" title="條列">${iconList}</button>
          <button type="button" class="home-mode-btn${!listOn ? ' is-active' : ''}" id="btn-mode-cards" aria-label="圖片顯示" title="圖片">${iconGallery}</button>
        </div>
      </div>
      ${body}
    </div>
    <nav class="home-bottom-nav" aria-label="功能列">
      <a class="home-feature" href="#/transcripts/lamrim" aria-label="手抄查詢">
        ${iconTranscripts}
        <span class="home-feature-label">手抄查詢</span>
      </a>
      <a class="home-feature" href="#/transcripts/kepan" aria-label="廣論科判">
        ${iconKepan}
        <span class="home-feature-label">科判</span>
      </a>
    </nav>
  `;

  bindHomeInteractions(app);
}

let transcriptsCleanup: (() => void) | null = null;

let viewerCleanup: (() => void) | null = null;

function renderViewer(
  book: BookItem,
  initial?: { initialBody?: number; initialPdf?: number },
): void {
  viewerCleanup?.();
  viewerCleanup = null;

  app.innerHTML = `
    <div class="viewer">
      <div class="viewer-stage-wrap" id="stage-wrap">
        <button type="button" class="viewer-exit-immersive" id="btn-exit-immersive" hidden aria-label="離開全螢幕（顯示工具列）">
          ✕
        </button>
        <div class="loading" id="loading">載入中…</div>
        <div class="viewer-stage" id="stage"></div>
        <button type="button" class="zone zone-left" id="zone-left" aria-label="下一頁"></button>
        <button type="button" class="zone zone-right" id="zone-right" aria-label="上一頁"></button>
      </div>
      <div class="viewer-toolbar">
        <div class="viewer-toolbar__row viewer-toolbar__row--top">
          <button type="button" id="btn-back">返回</button>
          <span class="grow" id="title">${book.title}</span>
          <label><input type="checkbox" id="chk-spread" /> 雙頁</label>
          <button type="button" id="btn-fullscreen" aria-pressed="false" aria-label="全螢幕">
            全螢幕
          </button>
        </div>
        <div class="viewer-toolbar__row viewer-toolbar__row--zoom">
          <div class="zoom-row-inner">
            <label class="zoom-label">縮放
              <input
                type="range"
                id="zoom-slider"
                min="50"
                max="300"
                step="1"
                value="100"
                aria-label="縮放比例 50% 至 300%"
                aria-valuemin="50"
                aria-valuemax="300"
              />
              <span id="zoom-pct" class="zoom-pct" aria-hidden="true">100%</span>
            </label>
            <button type="button" id="btn-zoom-fit" aria-label="重設為目前頁最適大小（100% 滿版）">
              滿版
            </button>
          </div>
        </div>
        <div class="viewer-toolbar__row viewer-toolbar__row--nav">
          <div class="viewer-nav-actions" id="nav-actions" role="group" aria-label="換頁與方向">
            <button type="button" id="btn-next">下一頁</button>
            <button type="button" id="btn-prev">上一頁</button>
            <label class="viewer-turn-label">
              <input type="checkbox" id="chk-turn-right" aria-label="改為右側點擊下一頁；滑動為向左下一頁、向右上一頁" />
              右側下一頁
            </label>
          </div>
        </div>
        <div class="goto-panel" id="goto-panel">
          <label><input type="radio" name="goto-mode" value="body" checked /> 正文頁</label>
          <label><input type="radio" name="goto-mode" value="pdf" /> 檔案頁</label>
          <input type="number" id="goto-input" min="1" value="1" inputmode="numeric" pattern="[0-9]*" autocomplete="off" />
          <button type="button" class="primary" id="btn-goto">前往</button>
        </div>
        <div class="status-line" id="status"></div>
      </div>
    </div>
  `;

  const stageWrap = app.querySelector<HTMLDivElement>('#stage-wrap')!;
  const stage = app.querySelector<HTMLDivElement>('#stage')!;
  const loadingEl = app.querySelector<HTMLDivElement>('#loading')!;
  const statusEl = app.querySelector<HTMLDivElement>('#status')!;
  const chkSpread = app.querySelector<HTMLInputElement>('#chk-spread')!;
  const gotoInput = app.querySelector<HTMLInputElement>('#goto-input')!;
  const btnBack = app.querySelector<HTMLButtonElement>('#btn-back')!;
  const btnPrev = app.querySelector<HTMLButtonElement>('#btn-prev')!;
  const btnNext = app.querySelector<HTMLButtonElement>('#btn-next')!;
  const btnGoto = app.querySelector<HTMLButtonElement>('#btn-goto')!;
  const zoneLeft = app.querySelector<HTMLButtonElement>('#zone-left')!;
  const zoneRight = app.querySelector<HTMLButtonElement>('#zone-right')!;
  const zoomSlider = app.querySelector<HTMLInputElement>('#zoom-slider')!;
  const zoomPct = app.querySelector<HTMLSpanElement>('#zoom-pct')!;
  const btnZoomFit = app.querySelector<HTMLButtonElement>('#btn-zoom-fit')!;
  const navActionsEl = app.querySelector<HTMLDivElement>('#nav-actions')!;
  const chkTurnRight = app.querySelector<HTMLInputElement>('#chk-turn-right')!;
  const viewerRoot = app.querySelector<HTMLDivElement>('.viewer')!;
  const btnFullscreen = app.querySelector<HTMLButtonElement>('#btn-fullscreen')!;
  const btnExitImmersive = app.querySelector<HTMLButtonElement>('#btn-exit-immersive')!;

  let doc: PDFDocumentProxy | null = null;
  let currentPage = 1;
  let spread = false;
  /** 在「適合視窗」基礎上的倍率，0.5 = 50% … 3 = 300% */
  let zoomMul = 1;
  let zoomSliderRaf = 0;
  let cancelled = false;
  /** 避免縮放／resize 連續觸發時，舊一輪在 await 後仍改寫狀態列 */
  let layoutVersion = 0;
  /** orientation／全螢幕後延遲重算 contain 基準用的 timeout（cleanup 時清除） */
  let stickyRefitSettleTimer = 0;
  /** iOS 等不支援元素全螢幕 API 時，改為隱藏工具列的沉浸閱讀 */
  let immersive = false;
  /** 目前閱讀區放大是否由「手機橫向自動」觸發（直向時才自動收回，避免蓋過手動全螢幕） */
  let autoChromeApplied = false;
  /**
   * 第一本書／同一版面下「100%」對應的 contain 基準。PDF 每頁尺寸不同，若每頁重算 rawFit，
   * 換頁後即使滑桿仍 100% 畫面也會忽大忽小；維持 max(sticky, rawFit) 可讓滿版感一致（較大頁可捲動）。
   */
  let stickyContainScale: number | null = null;

  function readNextOnLeftPref(): boolean {
    try {
      const v = localStorage.getItem(LS_READER_NEXT_ON_LEFT);
      if (v === '0' || v === 'false') return false;
      return true;
    } catch {
      return true;
    }
  }
  let nextOnLeft = readNextOnLeftPref();

  function persistNextOnLeft(v: boolean): void {
    try {
      localStorage.setItem(LS_READER_NEXT_ON_LEFT, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function syncTurnChrome(): void {
    chkTurnRight.checked = !nextOnLeft;
    navActionsEl.classList.toggle('viewer-nav-actions--right-next', !nextOnLeft);
    zoneLeft.setAttribute('aria-label', nextOnLeft ? '下一頁' : '上一頁');
    zoneRight.setAttribute('aria-label', nextOnLeft ? '上一頁' : '下一頁');
  }

  syncTurnChrome();

  const canvases: HTMLCanvasElement[] = [document.createElement('canvas'), document.createElement('canvas')];

  function invalidateStickyContainScale(): void {
    stickyContainScale = null;
  }

  /**
   * 橫向、自動全螢幕或工具列隱藏後，flex 與 safe-area 常晚一兩幀才穩定；若立刻重算會把 stickyContainScale
   * 鎖在舊視窗上，100% 看起來不對。延後再 invalidate 一次讓「適合視窗」對齊新寬高。
   */
  function scheduleStickyRefitAfterLayoutSettle(): void {
    if (stickyRefitSettleTimer !== 0) {
      window.clearTimeout(stickyRefitSettleTimer);
      stickyRefitSettleTimer = 0;
    }
    const bump = (): void => {
      if (cancelled || !doc) return;
      invalidateStickyContainScale();
      void updateScaleAndRender();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bump();
      });
    });
    stickyRefitSettleTimer = window.setTimeout(() => {
      stickyRefitSettleTimer = 0;
      bump();
    }, 160);
  }

  /** 邏輯上的 PDF 頁序（較小者為右頁／先讀） */
  function pageNumsToShow(): number[] {
    if (!doc) return [];
    if (!spread) return [currentPage];
    if (currentPage >= doc.numPages) return [currentPage];
    return [currentPage, currentPage + 1];
  }

  /** 左開雙頁：畫面上由左到右為「後一頁、前一頁」（右先讀） */
  function pageNumsForRender(logical: number[]): number[] {
    if (!spread || logical.length < 2) return logical;
    return [logical[1], logical[0]];
  }

  function zoomStatusSuffix(): string {
    return ` · 縮放 ${Math.round(zoomMul * 100)}%`;
  }

  async function updateScaleAndRender(): Promise<void> {
    if (!doc || cancelled) return;
    const v = ++layoutVersion;
    const { w: fitW, h: fitH } = readingStageFitSize(stageWrap);
    const logical = pageNumsToShow();
    const rawFit = await fitScale(doc, logical, fitW, fitH, 'contain');
    if (v !== layoutVersion || cancelled || !doc) return;
    if (stickyContainScale === null) stickyContainScale = rawFit;
    const baseFit = Math.max(stickyContainScale, rawFit);
    const renderScale = baseFit * zoomMul;
    const forRender = pageNumsForRender(logical);
    stage.classList.toggle('viewer-stage--spread-single-right', spread && logical.length === 1);
    stage.innerHTML = '';
    const n = forRender.length;
    for (let i = 0; i < n; i++) {
      stage.appendChild(canvases[i]);
    }
    await renderPages(doc, forRender, canvases.slice(0, n), renderScale);
    if (v !== layoutVersion || cancelled || !doc) return;
    statusEl.textContent =
      formatStatus(book, currentPage, doc.numPages, spread) + zoomStatusSuffix();
    statusEl.classList.remove('error');
  }

  function clampPage(p: number): number {
    if (!doc) return 1;
    return Math.max(1, Math.min(doc.numPages, p));
  }

  function step(delta: number): void {
    if (!doc) return;
    if (spread) {
      currentPage = clampPage(currentPage + delta * 2);
    } else {
      currentPage = clampPage(currentPage + delta);
    }
    void updateScaleAndRender();
    persistReadingProgress();
  }

  function onZoneLeftClick(): void {
    step(nextOnLeft ? 1 : -1);
  }

  function onZoneRightClick(): void {
    step(nextOnLeft ? -1 : 1);
  }

  function applyGoto(): void {
    if (!doc) return;
    const mode = app.querySelector<HTMLInputElement>('input[name="goto-mode"]:checked')!.value;
    const raw = Number(gotoInput.value);
    if (!Number.isFinite(raw) || raw < 1) {
      statusEl.textContent = '請輸入有效頁碼';
      statusEl.classList.add('error');
      return;
    }
    if (mode === 'pdf') {
      currentPage = clampPage(Math.floor(raw));
    } else {
      currentPage = clampPage(bodyPageToPdfPage(book, Math.floor(raw)));
    }
    gotoInput.blur();
    resetViewportZoomAfterKeyboard();
    void updateScaleAndRender();
    persistReadingProgress();
  }

  /** 把當前頁碼寫回網址（replaceState 不新增歷史紀錄），讓網址隨時可複製分享並直接跳到該頁 */
  function syncUrlToCurrentPage(mode: 'body' | 'pdf'): void {
    if (cancelled || !doc) return;
    const pageParam =
      mode === 'pdf' ? `pdf=${currentPage}` : `body=${pdfPageToBodyPage(book, currentPage)}`;
    const clean = `#/read/${book.id}?${pageParam}`;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${clean}`);
  }

  function persistReadingProgress(): void {
    if (cancelled || !doc) return;
    const checked = app.querySelector<HTMLInputElement>('input[name="goto-mode"]:checked');
    const mode = checked?.value === 'pdf' ? 'pdf' : 'body';
    writeStoredProgress(book.id, {
      pdfPage: currentPage,
      spread,
      gotoMode: mode,
      nextOnLeft,
    });
    persistNextOnLeft(nextOnLeft);
    syncUrlToCurrentPage(mode);
  }

  function onReaderVisibilityHidden(): void {
    if (document.visibilityState === 'hidden') persistReadingProgress();
  }

  function onReaderPageHide(): void {
    persistReadingProgress();
  }

  document.addEventListener('visibilitychange', onReaderVisibilityHidden);
  window.addEventListener('pagehide', onReaderPageHide);

  const ro = new ResizeObserver(() => {
    invalidateStickyContainScale();
    void updateScaleAndRender();
  });
  ro.observe(stageWrap);

  const visualViewport = window.visualViewport;
  function onVisualViewportResize(): void {
    invalidateStickyContainScale();
    void updateScaleAndRender();
  }
  function onVisualViewportScroll(): void {
    void updateScaleAndRender();
  }
  if (visualViewport) {
    visualViewport.addEventListener('resize', onVisualViewportResize);
    visualViewport.addEventListener('scroll', onVisualViewportScroll);
  }

  const canFullscreen =
    typeof viewerRoot.requestFullscreen === 'function' ||
    typeof (viewerRoot as HTMLElement & { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen ===
      'function';

  function syncChrome(): void {
    const fsOn = getFullscreenElement() === viewerRoot;
    const hideToolbar = immersive && !fsOn;
    viewerRoot.classList.toggle('viewer--immersive', hideToolbar);
    btnExitImmersive.hidden = !hideToolbar;
    const chromeReduced = fsOn || immersive;
    btnFullscreen.setAttribute('aria-pressed', chromeReduced ? 'true' : 'false');
    btnFullscreen.textContent = chromeReduced ? '離開全螢幕' : '全螢幕';
    btnFullscreen.setAttribute(
      'aria-label',
      chromeReduced
        ? '離開全螢幕'
        : canFullscreen
          ? '全螢幕'
          : '隱藏工具列（閱讀區加大，近似全螢幕）',
    );
  }

  function onFullscreenChange(): void {
    invalidateStickyContainScale();
    syncChrome();
    void updateScaleAndRender();
    scheduleStickyRefitAfterLayoutSettle();
  }

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  async function enterChromeFullscreenOrImmersive(): Promise<void> {
    if (getFullscreenElement() === viewerRoot || immersive) return;
    if (canFullscreen) {
      try {
        await requestFullscreenCompat(viewerRoot);
      } catch {
        immersive = true;
      }
    } else {
      immersive = true;
    }
    invalidateStickyContainScale();
    syncChrome();
    void updateScaleAndRender();
    scheduleStickyRefitAfterLayoutSettle();
  }

  async function leaveChromeFullscreenAndImmersive(): Promise<void> {
    if (getFullscreenElement() === viewerRoot) {
      await exitFullscreenCompat();
    }
    immersive = false;
    invalidateStickyContainScale();
    syncChrome();
    void updateScaleAndRender();
    scheduleStickyRefitAfterLayoutSettle();
  }

  function phoneLandscapeEligibleForAutoFs(): boolean {
    try {
      if (typeof window.matchMedia !== 'function') return false;
      if (!window.matchMedia('(orientation: landscape)').matches) return false;
      /* 僅觸控為主裝置；勿用 max-width，否則筆電窄視窗也會被當手機而自動全螢幕 */
      return window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  const mqOrientationLandscape = window.matchMedia('(orientation: landscape)');
  let autoLandscapeChromeRaf = 0;

  function scheduleAutoLandscapeChrome(): void {
    if (cancelled) return;
    if (autoLandscapeChromeRaf !== 0) cancelAnimationFrame(autoLandscapeChromeRaf);
    autoLandscapeChromeRaf = requestAnimationFrame(() => {
      autoLandscapeChromeRaf = 0;
      window.setTimeout(() => {
        syncAutoLandscapeChrome();
        scheduleStickyRefitAfterLayoutSettle();
      }, 80);
    });
  }

  function syncAutoLandscapeChrome(): void {
    if (cancelled) return;
    const land = phoneLandscapeEligibleForAutoFs();
    if (land) {
      if (getFullscreenElement() === viewerRoot || immersive) return;
      autoChromeApplied = true;
      void enterChromeFullscreenOrImmersive();
    } else if (autoChromeApplied) {
      autoChromeApplied = false;
      void leaveChromeFullscreenAndImmersive();
    }
  }

  mqOrientationLandscape.addEventListener('change', scheduleAutoLandscapeChrome);
  window.addEventListener('orientationchange', scheduleAutoLandscapeChrome);

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartZoomMul = 1;
  /** 單指水平滑動換頁（左右滑向與點擊區對調）；雙指時會清除 */
  let swipeTrack: { x: number; y: number; t: number; id: number } | null = null;

  function touchDistance(touches: TouchList): number {
    if (touches.length < 2) return 0;
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  }

  function scheduleZoomRender(): void {
    if (zoomSliderRaf !== 0) return;
    zoomSliderRaf = requestAnimationFrame(() => {
      zoomSliderRaf = 0;
      void updateScaleAndRender();
    });
  }

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length >= 2) {
      swipeTrack = null;
      pinchActive = true;
      pinchStartDist = Math.max(touchDistance(e.touches), 8);
      pinchStartZoomMul = zoomMul;
    } else if (e.touches.length === 1) {
      const t = e.touches[0]!;
      swipeTrack = { x: t.clientX, y: t.clientY, t: Date.now(), id: t.identifier };
    }
  }

  function onTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 2) return;
    if (!pinchActive) {
      pinchActive = true;
      pinchStartDist = Math.max(touchDistance(e.touches), 8);
      pinchStartZoomMul = zoomMul;
    }
    e.preventDefault();
    const dist = touchDistance(e.touches);
    if (dist < 4) return;
    const ratio = dist / pinchStartDist;
    const nextMul = pinchStartZoomMul * ratio;
    const pct = Math.round(Math.max(50, Math.min(300, nextMul * 100)));
    zoomSlider.value = String(pct);
    applyZoomFromSlider();
    scheduleZoomRender();
  }

  function onTouchEnd(e: TouchEvent): void {
    if (swipeTrack) {
      let lifted: Touch | undefined;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const c = e.changedTouches[i]!;
        if (c.identifier === swipeTrack.id) {
          lifted = c;
          break;
        }
      }
      if (lifted) {
        const st = swipeTrack;
        swipeTrack = null;
        const dt = Date.now() - st.t;
        const dx = lifted.clientX - st.x;
        const dy = lifted.clientY - st.y;
        const horiz = Math.abs(dx) >= 52 && Math.abs(dx) >= Math.abs(dy) * 1.2;
        const speed = Math.abs(dx) / Math.max(dt, 16);
        /* 需偏快或滑距夠長，避免放大後慢速橫向捲動誤觸換頁 */
        const flick = horiz && dt >= 40 && dt < 720 && !pinchActive && (speed >= 0.28 || Math.abs(dx) >= 96);
        if (flick) {
          if (dx < 0) step(nextOnLeft ? -1 : 1);
          else step(nextOnLeft ? 1 : -1);
        }
      }
    }
    if (e.touches.length < 2) pinchActive = false;
  }

  /** iOS：攔截預設 pinch 手勢，改由我們重繪 PDF */
  const onGesturePrevent = (ev: Event) => {
    ev.preventDefault();
  };

  function onTouchCancel(): void {
    swipeTrack = null;
    pinchActive = false;
  }

  stageWrap.addEventListener('touchstart', onTouchStart, { passive: true });
  stageWrap.addEventListener('touchmove', onTouchMove, { passive: false });
  stageWrap.addEventListener('touchend', onTouchEnd, { passive: true });
  stageWrap.addEventListener('touchcancel', onTouchCancel, { passive: true });
  stageWrap.addEventListener('gesturestart', onGesturePrevent, { passive: false });
  stageWrap.addEventListener('gesturechange', onGesturePrevent, { passive: false });
  stageWrap.addEventListener('gestureend', onGesturePrevent, { passive: false });

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  }
  window.addEventListener('keydown', onKey);

  btnBack.addEventListener('click', () => navigateHome());
  btnNext.addEventListener('click', () => step(1));
  btnPrev.addEventListener('click', () => step(-1));
  zoneLeft.addEventListener('click', onZoneLeftClick);
  zoneRight.addEventListener('click', onZoneRightClick);
  chkSpread.addEventListener('change', () => {
    spread = chkSpread.checked;
    currentPage = clampPage(currentPage);
    invalidateStickyContainScale();
    void updateScaleAndRender();
    persistReadingProgress();
  });
  function applyZoomFromSlider(): void {
    const raw = Number.parseInt(zoomSlider.value, 10);
    const pct = Math.max(50, Math.min(300, Number.isFinite(raw) ? raw : 100));
    zoomMul = pct / 100;
    zoomPct.textContent = `${pct}%`;
    zoomSlider.setAttribute('aria-valuenow', String(pct));
  }

  function onZoomSliderInput(): void {
    applyZoomFromSlider();
    scheduleZoomRender();
  }

  zoomSlider.addEventListener('input', onZoomSliderInput);
  btnZoomFit.addEventListener('click', () => {
    zoomSlider.value = '100';
    applyZoomFromSlider();
    invalidateStickyContainScale();
    void updateScaleAndRender();
    scheduleStickyRefitAfterLayoutSettle();
  });
  chkTurnRight.addEventListener('change', () => {
    nextOnLeft = !chkTurnRight.checked;
    persistNextOnLeft(nextOnLeft);
    syncTurnChrome();
  });
  btnFullscreen.addEventListener('click', () => {
    void (async () => {
      autoChromeApplied = false;
      if (getFullscreenElement() === viewerRoot || immersive) {
        await leaveChromeFullscreenAndImmersive();
        return;
      }
      await enterChromeFullscreenOrImmersive();
    })();
  });
  btnExitImmersive.addEventListener('click', () => {
    autoChromeApplied = false;
    void leaveChromeFullscreenAndImmersive();
  });
  syncChrome();
  btnGoto.addEventListener('click', () => applyGoto());
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyGoto();
  });
  app.querySelectorAll<HTMLInputElement>('input[name="goto-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => persistReadingProgress());
  });

  viewerCleanup = () => {
    persistReadingProgress();
    document.removeEventListener('visibilitychange', onReaderVisibilityHidden);
    window.removeEventListener('pagehide', onReaderPageHide);
    cancelled = true;
    autoChromeApplied = false;
    if (stickyRefitSettleTimer !== 0) {
      window.clearTimeout(stickyRefitSettleTimer);
      stickyRefitSettleTimer = 0;
    }
    if (autoLandscapeChromeRaf !== 0) {
      cancelAnimationFrame(autoLandscapeChromeRaf);
      autoLandscapeChromeRaf = 0;
    }
    mqOrientationLandscape.removeEventListener('change', scheduleAutoLandscapeChrome);
    window.removeEventListener('orientationchange', scheduleAutoLandscapeChrome);
    immersive = false;
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    if (getFullscreenElement() === viewerRoot) {
      void exitFullscreenCompat();
    }
    if (visualViewport) {
      visualViewport.removeEventListener('resize', onVisualViewportResize);
      visualViewport.removeEventListener('scroll', onVisualViewportScroll);
    }
    ro.disconnect();
    window.removeEventListener('keydown', onKey);
    zoneLeft.removeEventListener('click', onZoneLeftClick);
    zoneRight.removeEventListener('click', onZoneRightClick);
    stageWrap.removeEventListener('touchstart', onTouchStart);
    stageWrap.removeEventListener('touchmove', onTouchMove);
    stageWrap.removeEventListener('touchend', onTouchEnd);
    stageWrap.removeEventListener('touchcancel', onTouchCancel);
    stageWrap.removeEventListener('gesturestart', onGesturePrevent);
    stageWrap.removeEventListener('gesturechange', onGesturePrevent);
    stageWrap.removeEventListener('gestureend', onGesturePrevent);
    destroyDocument();
  };

  void (async () => {
    try {
      const url = resolvePdfUrl(book.pdfPath);
      statusEl.textContent = `請求：${url}`;
      doc = await loadDocument(book);
      if (cancelled) return;
      currentPage = 1;
      spread = false;
      chkSpread.checked = false;
      zoomSlider.value = '100';
      applyZoomFromSlider();
      const gotoBodyRadio = app.querySelector<HTMLInputElement>('input[name="goto-mode"][value="body"]')!;
      const gotoPdfRadio = app.querySelector<HTMLInputElement>('input[name="goto-mode"][value="pdf"]')!;
      const saved = readStoredProgress(book.id);
      if (initial?.initialPdf != null && Number.isFinite(initial.initialPdf)) {
        currentPage = clampPage(Math.floor(initial.initialPdf!));
        gotoPdfRadio.checked = true;
        gotoBodyRadio.checked = false;
        gotoInput.value = String(currentPage);
      } else if (initial?.initialBody != null && Number.isFinite(initial.initialBody)) {
        const bRequested = Math.floor(initial.initialBody!);
        currentPage = clampPage(bodyPageToPdfPage(book, bRequested));
        gotoBodyRadio.checked = true;
        gotoPdfRadio.checked = false;
        gotoInput.value = String(bRequested);
      } else if (saved) {
        currentPage = clampPage(saved.pdfPage);
        spread = saved.spread;
        chkSpread.checked = spread;
        if (saved.gotoMode === 'pdf') {
          gotoPdfRadio.checked = true;
          gotoBodyRadio.checked = false;
          gotoInput.value = String(currentPage);
        } else {
          gotoBodyRadio.checked = true;
          gotoPdfRadio.checked = false;
          gotoInput.value = String(pdfPageToBodyPage(book, currentPage));
        }
      } else {
        gotoBodyRadio.checked = true;
        gotoPdfRadio.checked = false;
        gotoInput.value = String(pdfPageToBodyPage(book, currentPage));
      }
      if (saved?.nextOnLeft != null) {
        nextOnLeft = saved.nextOnLeft;
        syncTurnChrome();
      }
      syncUrlToCurrentPage(gotoPdfRadio.checked ? 'pdf' : 'body');
      loadingEl.classList.add('hidden');
      await updateScaleAndRender();
      scheduleAutoLandscapeChrome();
      /* 首幀時 flex／visualViewport 常尚未穩定，sticky 會鎖錯 rawFit（易過大）；延後一輪再重算 contain */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled || !doc) return;
          invalidateStickyContainScale();
          void updateScaleAndRender();
        });
      });
    } catch (err) {
      if (!cancelled) {
        loadingEl.textContent = '無法載入檔案';
        statusEl.textContent = String(err);
        statusEl.classList.add('error');
      }
    }
  })();
}

window.addEventListener('hashchange', () => render());
render();
