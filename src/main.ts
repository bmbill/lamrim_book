import './style.css';
import {
  LAMRIM_MAIN,
  NANSHAN_LAY,
  bodyPageToPdfPage,
  nanputuoVolumeId,
  nanputuoVolumes,
  nanshanVinayaBookId,
  nanshanVinayaBooks,
  resolvePdfUrl,
  type BookItem,
} from './books';
import { destroyDocument, fitScale, formatStatus, loadDocument, renderPages } from './viewer';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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
 * 手機上 layout 視窗高度常大於「實際可視區」（網址列、100vh/dvh 落差）。用 visualViewport 與元素的交集
 * 計算 contain 用的寬高，避免 baseFit 過大、預設 100% 卻像放大鏡只見局部。
 */
function visibleFitSize(el: HTMLElement): { w: number; h: number } {
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const rw = Math.max(1, r.width);
  const rh = Math.max(1, r.height);
  if (!vv) return { w: rw, h: rh };

  const interL = Math.max(r.left, vv.offsetLeft);
  const interT = Math.max(r.top, vv.offsetTop);
  const interR = Math.min(r.right, vv.offsetLeft + vv.width);
  const interB = Math.min(r.bottom, vv.offsetTop + vv.height);
  const interW = interR - interL;
  const interH = interB - interT;

  const capW = Math.min(rw, vv.width);
  const capH = Math.min(rh, vv.height, Math.max(0, vv.offsetTop + vv.height - r.top));

  const w = Math.max(32, Math.min(interW >= 32 ? interW : capW, capW));
  const h = Math.max(32, Math.min(interH >= 32 ? interH : capH, capH));
  return { w, h };
}

/** 與 index.html 一致；用於 iOS 聚焦輸入後短暫限制縮放以還原整頁比例 */
const VIEWPORT_META_DEFAULT = 'width=device-width, initial-scale=1, viewport-fit=cover';

/** iOS 輸入頁碼常仍會整頁放大；前往後 blur 並短暫改 viewport 再還原，盡量回到原顯示比例 */
function resetViewportZoomAfterKeyboard(): void {
  if (!/iP(hone|ad|od)/i.test(navigator.userAgent)) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', `${VIEWPORT_META_DEFAULT}, maximum-scale=1`);
  window.setTimeout(() => {
    meta.setAttribute('content', VIEWPORT_META_DEFAULT);
  }, 250);
}

const LS_HOME_DISPLAY = 'lamrim-home-display';
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
  | { route: 'read'; id: string; initialBody?: number; initialPdf?: number };

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
  const q: string[] = [];
  if (opts?.body != null && Number.isFinite(opts.body)) q.push(`body=${Math.floor(opts.body)}`);
  if (opts?.pdf != null && Number.isFinite(opts.pdf)) q.push(`pdf=${Math.floor(opts.pdf)}`);
  const qs = q.length ? `?${q.join('&')}` : '';
  window.location.hash = `#/read/${id}${qs}`;
  render();
}

function stripHashQuery(id: string): void {
  if (!window.location.hash.includes('?')) return;
  const clean = `#/read/${id}`;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}${clean}`);
}

function render(): void {
  const r = parseHash();
  if (r.route === 'home') {
    viewerCleanup?.();
    viewerCleanup = null;
    destroyDocument();
    renderHome();
  } else {
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

  app.innerHTML = `
    <div class="home">
      <div class="home-header">
        <h1>廣論與南山律 PDF 閱讀</h1>
        <div class="home-toolbar" role="group" aria-label="首頁顯示方式">
          <button type="button" class="home-mode-btn${listOn ? ' is-active' : ''}" id="btn-mode-list" aria-label="條列顯示" title="條列">${iconList}</button>
          <button type="button" class="home-mode-btn${!listOn ? ' is-active' : ''}" id="btn-mode-cards" aria-label="圖片顯示" title="圖片">${iconGallery}</button>
        </div>
      </div>
      ${body}
    </div>
  `;

  bindHomeInteractions(app);
}

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
        <!-- 固定左開：左＝下一頁、右＝上一頁 -->
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
          </div>
        </div>
        <div class="viewer-toolbar__row viewer-toolbar__row--nav">
          <button type="button" id="btn-next">下一頁</button>
          <button type="button" id="btn-prev">上一頁</button>
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
  /** iOS 等不支援元素全螢幕 API 時，改為隱藏工具列的沉浸閱讀 */
  let immersive = false;
  /**
   * 第一本書／同一版面下「100%」對應的 contain 基準。PDF 每頁尺寸不同，若每頁重算 rawFit，
   * 換頁後即使滑桿仍 100% 畫面也會忽大忽小；維持 max(sticky, rawFit) 可讓滿版感一致（較大頁可捲動）。
   */
  let stickyContainScale: number | null = null;

  const canvases: HTMLCanvasElement[] = [document.createElement('canvas'), document.createElement('canvas')];

  function invalidateStickyContainScale(): void {
    stickyContainScale = null;
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
    const { w: fitW, h: fitH } = visibleFitSize(stageWrap);
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
  }

  function onZoneLeftClick(): void {
    step(1);
  }

  function onZoneRightClick(): void {
    step(-1);
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
  }

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
  }

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartZoomMul = 1;

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
    if (e.touches.length === 2) {
      pinchActive = true;
      pinchStartDist = Math.max(touchDistance(e.touches), 8);
      pinchStartZoomMul = zoomMul;
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
    if (e.touches.length < 2) pinchActive = false;
  }

  /** iOS：攔截預設 pinch 手勢，改由我們重繪 PDF */
  const onGesturePrevent = (ev: Event) => {
    ev.preventDefault();
  };

  stageWrap.addEventListener('touchstart', onTouchStart, { passive: true });
  stageWrap.addEventListener('touchmove', onTouchMove, { passive: false });
  stageWrap.addEventListener('touchend', onTouchEnd, { passive: true });
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
  btnFullscreen.addEventListener('click', () => {
    void (async () => {
      if (getFullscreenElement() === viewerRoot) {
        await exitFullscreenCompat();
        invalidateStickyContainScale();
        syncChrome();
        void updateScaleAndRender();
        return;
      }
      if (immersive) {
        immersive = false;
        invalidateStickyContainScale();
        syncChrome();
        void updateScaleAndRender();
        return;
      }
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
    })();
  });
  btnExitImmersive.addEventListener('click', () => {
    immersive = false;
    invalidateStickyContainScale();
    syncChrome();
    void updateScaleAndRender();
  });
  syncChrome();
  btnGoto.addEventListener('click', () => applyGoto());
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyGoto();
  });

  viewerCleanup = () => {
    cancelled = true;
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
      if (initial?.initialPdf != null && Number.isFinite(initial.initialPdf)) {
        currentPage = clampPage(Math.floor(initial.initialPdf!));
      } else if (initial?.initialBody != null && Number.isFinite(initial.initialBody)) {
        currentPage = clampPage(bodyPageToPdfPage(book, Math.floor(initial.initialBody!)));
      }
      stripHashQuery(book.id);
      loadingEl.classList.add('hidden');
      await updateScaleAndRender();
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
