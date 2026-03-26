/**
 * Fetch AMRTF nanputuo transcripts 001-320, parse blockquote + explanation + seek-to.
 * One flatSegment per blockquote; audioPlan chains tapes from HTML (blockquote boundaries).
 * Output: public/data/lamrim-transcripts.json.gz
 * Usage: node scripts/build-lamrim-transcripts.mjs [--max=N] [--start=N]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import * as cheerio from "cheerio";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lamrim-transcripts.json");
const OUT_GZ = path.join(ROOT, "public", "data", "lamrim-transcripts.json.gz");
const BASE = "https://www.amrtf.org/zh-hant/lamrim-transcripts-nanputuo-";

const argv = process.argv.slice(2);
let maxPages = 320;
let startPage = 1;
for (const a of argv) {
  const m = a.match(/^--max=(\d+)$/);
  if (m) maxPages = Number(m[1]);
  const s = a.match(/^--start=(\d+)$/);
  if (s) startPage = Number(s[1]);
}
const delayMs = Number(process.env.LAMRIM_FETCH_DELAY_MS || "150");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseTapeFromTitle(html) {
  if (typeof html !== "string" || !html.length) return null;
  const m = html.match(/南普陀版[）\)](\d{3})([AB])/u);
  if (!m) return null;
  return String(Number.parseInt(m[1], 10)) + m[2];
}

function normalizeForSearch(s) {
  return s.replace(/\s+/g, "").trim();
}

/** 手抄引文前的時間戳在 blockquote「之前」的段落裡，不在 nextUntil 範圍內 */
function lastSeekTimeBeforeBlockquote($, $bq) {
  let $w = $bq.prev();
  while ($w.length && !$w.is("blockquote")) {
    let $targets = $w.find("span.seek-to");
    if ($w.is("span.seek-to")) {
      $targets = $targets.add($w);
    }
    if ($targets.length) {
      const last = $targets.last();
      const t = last.attr("data-time");
      if (t != null) {
        const sec = Number.parseInt(t, 10);
        if (Number.isFinite(sec)) return sec;
      }
    }
    $w = $w.prev();
  }
  return null;
}

function explanationHtmlFromBq($, $bq) {
  return $bq
    .nextUntil("blockquote")
    .toArray()
    .map((el) => $.html(el))
    .join("");
}

/**
 * $main 內、第一個 blockquote 之前的 HTML（不限定頂層）。
 * 某些頁面 blockquote 包在容器裡，若只看頂層會誤把整段內容都納入 continuation。
 */
function htmlBeforeFirstBlockquote($main) {
  const html = $main.html() || "";
  const idx = html.search(/<blockquote(?:\\s|>)/i);
  if (idx < 0) return html;
  return html.slice(0, idx);
}

/** 整段 main 內容（該頁無 blockquote 時整頁當作續講緩衝） */
function fullMainHtml($, $main) {
  return $main
    .contents()
    .toArray()
    .map((node) => $.html(node))
    .join("");
}

function collectSeeksInHtmlOrder(html, hostSlug) {
  if (!html || !html.trim()) return [];
  const $ = cheerio.load(`<root>${html}</root>`);
  const out = [];
  $("span.seek-to").each((_, el) => {
    const t = $(el).attr("data-time");
    if (t == null) return;
    const sec = Number.parseInt(t, 10);
    if (Number.isFinite(sec)) out.push({ pageSlug: hostSlug, sec });
  });
  return out;
}

function parseCheerioPage(html, slug, pageUrl) {
  if (typeof html !== "string" || !html.length) {
    return { slug, pageUrl, tapeId: null, error: "no_html", $: null, $main: null, bqs: [] };
  }
  const tapeId = parseTapeFromTitle(html);
  const $ = cheerio.load(html);
  const $main = $(".oew-tabs-content-wrap").first();
  if (!$main.length) {
    return { slug, pageUrl, tapeId, error: "no_tabs_wrap", $: null, $main: null, bqs: [] };
  }
  const bqs = $main.find("blockquote").toArray();
  return { slug, pageUrl, tapeId, error: undefined, $, $main, bqs };
}

/** maxPageIdx：已抓取之最後一頁索引（含）；部分建置時不可指到未抓取的下一頁 */
function findNextEntry(pageIdx, ei, entryCounts, maxPageIdx) {
  const n = entryCounts[pageIdx] ?? 0;
  if (ei + 1 < n) return { pageIdx, ei: ei + 1 };
  for (let pi = pageIdx + 1; pi <= maxPageIdx; pi++) {
    if ((entryCounts[pi] ?? 0) > 0) return { pageIdx: pi, ei: 0 };
  }
  return null;
}

function pushPoint(points, pageSlug, sec) {
  const last = points[points.length - 1];
  if (last && last.pageSlug === pageSlug && last.sec === sec) return;
  points.push({ pageSlug, sec });
}

/**
 * @param {Array<{ pageSlug: string; sec: number }>} points
 * @param {string | null} endPageSlug
 * @param {number | null} endSec
 * @param {boolean} hasNextEntry
 */
function compressToAudioPlan(points, endPageSlug, endSec, hasNextEntry) {
  if (!points.length) {
    return [{ pageSlug: endPageSlug ?? "001", startSec: 0, endSec: hasNextEntry ? endSec : null }];
  }
  const groups = [];
  for (const p of points) {
    const g = groups[groups.length - 1];
    if (!g || g.slug !== p.pageSlug) {
      groups.push({ slug: p.pageSlug, secs: [p.sec] });
    } else {
      g.secs.push(p.sec);
    }
  }
  const steps = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const isLast = i === groups.length - 1;
    const startSec = g.secs[0];
    let stepEnd = null;
    if (isLast) {
      if (hasNextEntry && endSec != null && endPageSlug != null && g.slug === endPageSlug) {
        stepEnd = endSec;
      }
    }
    steps.push({ pageSlug: g.slug, startSec, endSec: stepEnd });
  }
  /**
   * 某些跨頁邊界的 first seek 就等於下一則 blockquote 邊界，
   * 會形成零長度尾段（start == end）。此段不包含可播放內容，移除之。
   */
  while (steps.length > 1) {
    const last = steps[steps.length - 1];
    if (last.endSec == null || last.endSec > last.startSec) break;
    steps.pop();
    steps[steps.length - 1].endSec = null;
  }
  return steps;
}

/**
 * homeCtx：該講次頁已 parse 之結果（每頁只 parse 一次，勿對每則 blockquote 重複 parse）。
 * @param {{ slug: string; pageUrl: string; html: string }[]} rows
 */
function buildEntryAudioPlan(rows, homeCtx, pageIdx, ei, entryCounts, maxPageIdx) {
  const ctx = homeCtx;
  if (!ctx.$ || !ctx.bqs[ei]) {
    return {
      audioPlan: [{ pageSlug: ctx.slug, startSec: 0, endSec: null }],
      continuationHtml: "",
      continuationText: "",
    };
  }
  const { $, $main, slug, bqs } = ctx;
  const $bq = $(bqs[ei]);
  const startSec = lastSeekTimeBeforeBlockquote($, $bq) ?? 0;
  const explanationHtml = explanationHtmlFromBq($, $bq);
  const next = findNextEntry(pageIdx, ei, entryCounts, maxPageIdx);

  let endSec = null;
  let endPageSlug = null;
  const continuationChunks = [];

  if (next) {
    if (next.pageIdx === pageIdx) {
      const $nextBq = $(bqs[next.ei]);
      endSec = lastSeekTimeBeforeBlockquote($, $nextBq);
      endPageSlug = slug;
    } else {
      for (let q = pageIdx + 1; q < next.pageIdx; q++) {
        const pq = parseCheerioPage(rows[q].html, rows[q].slug, rows[q].pageUrl);
        if (pq.$ && pq.$main) {
          continuationChunks.push({ slug: pq.slug, html: fullMainHtml(pq.$, pq.$main) });
        }
      }
      const pn = parseCheerioPage(
        rows[next.pageIdx].html,
        rows[next.pageIdx].slug,
        rows[next.pageIdx].pageUrl,
      );
      if (pn.$ && pn.$main) {
        continuationChunks.push({
          slug: pn.slug,
          html: htmlBeforeFirstBlockquote(pn.$main),
        });
      }
      if (pn.$ && pn.bqs.length) {
        const $nextBq = $(pn.bqs[0]);
        endSec = lastSeekTimeBeforeBlockquote(pn.$, $nextBq);
        endPageSlug = pn.slug;
      }
    }
  }

  const points = [];
  pushPoint(points, slug, startSec);
  for (const s of collectSeeksInHtmlOrder(explanationHtml, slug)) {
    pushPoint(points, s.pageSlug, s.sec);
  }
  for (const ch of continuationChunks) {
    for (const s of collectSeeksInHtmlOrder(ch.html, ch.slug)) {
      pushPoint(points, s.pageSlug, s.sec);
    }
  }

  const hasNextEntry = next != null;
  if (hasNextEntry && endSec != null && endPageSlug != null) {
    const hasOnEnd = points.some((p) => p.pageSlug === endPageSlug);
    /**
     * 只在該頁確實有本段內容（已收集到 seek）時，才把 endSec 掛在該頁。
     * 否則會產生「只有邊界、沒有內容」的 0 秒跨頁步驟（例如 016 -> 017:13..13）。
     */
    if (hasOnEnd) {
      pushPoint(points, endPageSlug, endSec);
    }
  }

  const audioPlan = compressToAudioPlan(points, endPageSlug, endSec, hasNextEntry);

  const continuationHtml = continuationChunks.map((c) => c.html).join("");
  const continuationText = continuationChunks
    .map((c) => {
      const $w = cheerio.load(`<wrap>${c.html}</wrap>`);
      return $w("wrap").text();
    })
    .join("");

  return { audioPlan, continuationHtml, continuationText };
}

async function fetchPage(n) {
  const slug = String(n).padStart(3, "0");
  const u = `${BASE}${slug}/`;
  const res = await fetch(u, {
    headers: { "User-Agent": "lamrim-book-reader/1.0 (transcript-index)" },
  });
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  const html = await res.text();
  return { slug, pageUrl: u, html };
}

async function main() {
  const rows = [];
  const pagesPayload = [];
  const end = Math.min(320, startPage + maxPages - 1);
  for (let n = startPage; n <= end; n++) {
    process.stderr.write(`\rfetch ${n}/${end}   `);
    const raw = await fetchPage(n);
    rows.push({ slug: raw.slug, pageUrl: raw.pageUrl, html: raw.html });
    const ctx = parseCheerioPage(raw.html, raw.slug, raw.pageUrl);
    if (!ctx.$) {
      pagesPayload.push({
        slug: ctx.slug,
        pageUrl: ctx.pageUrl,
        tapeId: ctx.tapeId,
        entries: [],
        error: ctx.error,
      });
    } else {
      const { $, bqs, slug, pageUrl, tapeId } = ctx;
      const entries = bqs.map(($el) => {
        const $bq = $($el);
        return {
          quoteText: normalizeForSearch($bq.text()),
          quoteHtml: $bq.html() || "",
          explanationHtml: explanationHtmlFromBq($, $bq),
          explanationText: $bq.nextUntil("blockquote").text(),
        };
      });
      pagesPayload.push({ slug, pageUrl, tapeId, entries });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  process.stderr.write("\n");

  const entryCounts = pagesPayload.map((p) => p.entries.length);
  const maxPageIdx = rows.length - 1;

  const flatSegments = [];
  let segId = 0;
  for (let pageIdx = 0; pageIdx < rows.length; pageIdx++) {
    const page = pagesPayload[pageIdx];
    if (!page.entries.length) continue;
    const homeCtx = parseCheerioPage(rows[pageIdx].html, rows[pageIdx].slug, rows[pageIdx].pageUrl);
    if (!homeCtx.$) continue;
    for (let ei = 0; ei < page.entries.length; ei++) {
      const ent = page.entries[ei];
      const { audioPlan, continuationHtml, continuationText } = buildEntryAudioPlan(
        rows,
        homeCtx,
        pageIdx,
        ei,
        entryCounts,
        maxPageIdx,
      );
      const first = audioPlan[0];
      const last = audioPlan[audioPlan.length - 1];
      flatSegments.push({
        id: segId++,
        tapeId: page.tapeId,
        pageSlug: page.slug,
        pageUrl: page.pageUrl,
        entryIndex: ei,
        segmentIndex: 0,
        quoteText: ent.quoteText,
        quoteHtml: ent.quoteHtml,
        explanationHtml: ent.explanationHtml,
        explanationText: ent.explanationText,
        continuationHtml,
        continuationText,
        startSec: first?.startSec ?? 0,
        endSec: last?.endSec ?? null,
        audioPlan,
      });
    }
  }

  for (const r of rows) {
    r.html = "";
  }

  const payload = {
    builtAt: new Date().toISOString(),
    source: BASE,
    pages: pagesPayload,
    flatSegments,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const payloadJson = JSON.stringify(payload);
  fs.writeFileSync(OUT_GZ, zlib.gzipSync(Buffer.from(payloadJson, "utf8"), { level: 9 }));
  if (process.env.KEEP_LAMRIM_JSON === "1") {
    fs.writeFileSync(OUT, payloadJson, "utf8");
  } else {
    try {
      fs.unlinkSync(OUT);
    } catch {
      /* ignore */
    }
  }
  console.log("Wrote", OUT_GZ, "pages", pagesPayload.length, "flatSegments", flatSegments.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
