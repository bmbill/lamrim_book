/**
 * Fetch 鳳山寺版 lamrim transcripts from blisswisdom.org; each lesson page
 * contains a single MP3 split into segments marked by <span class="time"
 * title="MM:SS"> tags. A <p> may contain both commentary text AND the
 * following marker, so we walk inline content by nodes rather than by <p>.
 *
 * Quote 廣論原文 = <h4> elements (excluding .masterquote / .kepan / .original).
 * Explanation = running text between markers (text nodes + non-time inline
 * elements in <p>s, plus other direct-child elements).
 *
 * Output: public/data/fengshan-transcripts.json.gz
 * Usage:  node scripts/build-fengshan-transcripts.mjs [--max=N] [--start=N]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import * as cheerio from "cheerio";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "fengshan-transcripts.json");
const OUT_GZ = path.join(ROOT, "public", "data", "fengshan-transcripts.json.gz");
const INDEX_URL = "https://www.blisswisdom.org/teachings/lamrim2";
const UA = "lamrim-book-reader/1.0 (transcript-index)";

const argv = process.argv.slice(2);
let maxLessons = 200;
let startLesson = 1;
for (const a of argv) {
  const m = a.match(/^--max=(\d+)$/);
  if (m) maxLessons = Number(m[1]);
  const s = a.match(/^--start=(\d+)$/);
  if (s) startLesson = Number(s[1]);
}
const delayMs = Number(process.env.FENGSHAN_FETCH_DELAY_MS || "200");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeForSearch(s) {
  return (s || "").replace(/\s+/g, "").trim();
}

function hasNonWhitespace(s) {
  return typeof s === "string" && s.replace(/[\s\u3000]+/g, "").length > 0;
}

function parseMMSS(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss >= 60) return null;
  return mm * 60 + ss;
}

/** 接受 MM:SS 或 H:MM:SS（鳳山寺索引表的卷末時間偶有超過一小時者） */
function parseClock(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const m3 = t.match(/^(\d+):(\d{1,2}):(\d{2})$/);
  if (m3) {
    const h = Number(m3[1]);
    const mi = Number(m3[2]);
    const se = Number(m3[3]);
    if (![h, mi, se].every(Number.isFinite) || mi >= 60 || se >= 60) return null;
    return h * 3600 + mi * 60 + se;
  }
  return parseMMSS(t);
}

async function fetchText(u) {
  const res = await fetch(u, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  return await res.text();
}

/**
 * 索引頁解析：除了擷取 lesson URL 清單，還抓取每列的「卷範圍」欄，例如：
 *   第1卷 00:03 ~ 46:46
 *   第1卷 46:46 ~ 第2卷 48:04
 *   第3卷 00:00 ~ 第5卷 32:50
 *   第63卷 43:34 ~ 第67卷 1:00:40   （小時:分:秒）
 * 回傳 { lessons, tapeRanges }；tapeRanges 以 lessonSlug 為鍵。
 */
function parseTapeRange(s) {
  if (!s) return null;
  const txt = s.replace(/\s+/g, " ").trim();
  const re = /第(\d+)卷\s*(\d+(?::\d+){1,2})\s*[~～]\s*(?:第(\d+)卷\s*)?(\d+(?::\d+){1,2})/u;
  const m = txt.match(re);
  if (!m) return null;
  const startTape = Number(m[1]);
  const startTapeSec = parseClock(m[2]);
  const endTape = m[3] ? Number(m[3]) : startTape;
  const endTapeSec = parseClock(m[4]);
  if (!Number.isFinite(startTape) || !Number.isFinite(endTape)) return null;
  if (startTapeSec == null || endTapeSec == null) return null;
  return { startTape, startTapeSec, endTape, endTapeSec };
}

function parseIndex(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const lessons = [];
  const tapeRanges = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const $a = $tr.find('a[href*="/teachings/lamrim2/"]').first();
    if (!$a.length) return;
    const href = $a.attr("href") || "";
    const m = href.match(/\/teachings\/lamrim2\/(\d+)-(\d+)(?:\/|$|\?)/);
    if (!m) return;
    const articleId = m[1];
    const lessonNum = Number(m[2]);
    const slug = String(lessonNum).padStart(2, "0");
    if (seen.has(slug)) return;
    seen.add(slug);
    const abs = href.startsWith("http") ? href : `https://www.blisswisdom.org${href}`;
    lessons.push({ lessonNum, articleId, slug, pageUrl: abs });

    const cellTexts = $tr
      .find("td div")
      .toArray()
      .map((el) => $(el).text());
    let parsed = null;
    for (const t of cellTexts) {
      if (/第\s*\d+\s*卷/.test(t)) {
        parsed = parseTapeRange(t);
        if (parsed) break;
      }
    }
    if (parsed) tapeRanges.push({ lessonSlug: slug, ...parsed });
  });

  lessons.sort((a, b) => a.lessonNum - b.lessonNum);
  tapeRanges.sort((a, b) => Number(a.lessonSlug) - Number(b.lessonSlug));
  return { lessons, tapeRanges };
}

function extractLessonTitle($) {
  const t = $("head > title").first().text() || "";
  return (t.split("|")[0] || t).trim();
}

function extractAudioUrl($) {
  const src = $("audio source").first().attr("src");
  if (typeof src === "string" && src.trim().length > 0) return src.trim();
  return null;
}

function isTimeSpan($el) {
  if (!$el || !$el.length) return false;
  const cls = ($el.attr("class") || "").split(/\s+/);
  return cls.includes("time");
}

function parseTimeSpan($time) {
  const title = $time.attr("title") || "";
  const startSec = parseClock(title);
  const oText = $time.find("span.o_time").first().text().trim();
  let originalTape = null;
  const m = oText.match(/第\s*(\d+)\s*卷\s*(\d+:\d{2}(?::\d{2})?)/);
  if (m) {
    const vol = Number(m[1]);
    const sec = parseClock(m[2]);
    if (Number.isFinite(vol) && sec != null) originalTape = { volume: vol, startSec: sec };
  }
  return { startSec, originalTape };
}

function isQuoteH4($h4) {
  const cls = ($h4.attr("class") || "").toLowerCase();
  if (!cls) return true;
  if (cls.includes("masterquote")) return false;
  if (cls.includes("kepan")) return false;
  if (cls.includes("original")) return false;
  return true;
}

/**
 * 段落切分：以 <h4>（廣論原文）為段落起點；每段含一個 <h4> 及其後、下一個
 * <h4> 之前的所有解釋內容。<span class="time"> 僅用作音檔時間錨點——最近的
 * 時間標記在遇到 <h4> 時被採為該段的 startSec / originalTape。
 *
 * 特殊處理：
 *   1. 第一個 <h4> 之前的內容，若存在有意義的解釋文字，併入該 <h4> 之段落。
 *   2. 整講次完全沒有 <h4>（如 lesson 01「要旨總說」）時，退化為單一段
 *      （quote 為空），仍收錄解釋文字，以利瀏覽。
 */
function parseLesson(html, info) {
  const $ = cheerio.load(html);
  const $main = $("section.article-content.lamrimcontent").first();
  const lessonTitle = extractLessonTitle($);
  const audioUrl = extractAudioUrl($);
  if (!$main.length) return { ...info, lessonTitle, audioUrl, segments: [] };

  const segments = [];
  let cur = null;
  let seenH4 = false;
  const preParts = [];
  let pendingStartSec = 0;
  let pendingOriginalTape = null;

  const flush = () => {
    if (cur) segments.push(cur);
    cur = null;
  };
  const openSegment = () => {
    cur = {
      startSec: pendingStartSec,
      originalTape: pendingOriginalTape,
      quoteParts: [],
      explParts: [],
    };
  };
  const addTo = (target, html, text) => {
    if (!hasNonWhitespace(text)) return;
    target.push({ html, text });
  };

  const children = $main.children().toArray();
  for (const node of children) {
    const $el = $(node);
    const tag = (node.tagName || node.name || "").toLowerCase();

    if (tag === "p") {
      let textBuf = "";
      let htmlBuf = "";
      const flushBuf = () => {
        if (!hasNonWhitespace(textBuf)) {
          textBuf = "";
          htmlBuf = "";
          return;
        }
        const target = cur ? cur.explParts : preParts;
        addTo(target, `<p>${htmlBuf}</p>`, textBuf);
        textBuf = "";
        htmlBuf = "";
      };
      for (const c of $el.contents().toArray()) {
        if (c.type === "text") {
          const t = c.data || "";
          textBuf += t;
          htmlBuf += t;
          continue;
        }
        if (c.type !== "tag") continue;
        const $c = $(c);
        const ctag = (c.tagName || c.name || "").toLowerCase();
        if (ctag === "span" && isTimeSpan($c)) {
          // 時間錨點：不切段，僅更新 pendingStartSec / originalTape 供下次
          // <h4> 使用；先把已累積的文字 flush 成該段之解釋 chunk
          flushBuf();
          const { startSec, originalTape } = parseTimeSpan($c);
          if (startSec != null) {
            pendingStartSec = startSec;
            pendingOriginalTape = originalTape;
          }
          continue;
        }
        textBuf += $c.text();
        htmlBuf += $.html(c);
      }
      flushBuf();
      continue;
    }

    if (tag === "h4") {
      if (!isQuoteH4($el)) continue;
      flush();
      openSegment();
      // 第一個 h4：把累積的前言解釋併入此段
      if (!seenH4 && preParts.length) {
        cur.explParts.push(...preParts);
        preParts.length = 0;
      }
      cur.quoteParts.push({ html: $.html($el), text: $el.text() });
      seenH4 = true;
      continue;
    }

    const txt = $el.text();
    if (hasNonWhitespace(txt)) {
      const target = cur ? cur.explParts : preParts;
      addTo(target, $.html(node), txt);
    }
  }
  flush();

  // 整講次沒有任何 h4 → 發射單一段落作為保底（lessons like 01「要旨總說」）
  if (!seenH4 && preParts.length) {
    segments.push({
      startSec: 0,
      originalTape: pendingOriginalTape,
      quoteParts: [],
      explParts: preParts.slice(),
    });
  }

  return { ...info, lessonTitle, audioUrl, segments };
}

function buildFlatSegments(lessons) {
  const pages = [];
  const flatSegments = [];
  let segId = 0;

  for (const lesson of lessons) {
    const pageEntries = [];
    for (let i = 0; i < lesson.segments.length; i++) {
      const seg = lesson.segments[i];
      // 多個 h4 共享同一時間錨點時，endSec 應指向「下一個不同 startSec」的段落
      // （而非相鄰段），否則會出現 startSec === endSec 的零長度範圍
      let endSec = null;
      for (let j = i + 1; j < lesson.segments.length; j++) {
        if (lesson.segments[j].startSec > seg.startSec) {
          endSec = lesson.segments[j].startSec;
          break;
        }
      }

      const quoteHtml = seg.quoteParts.map((p) => p.html).join("");
      const quoteText = normalizeForSearch(seg.quoteParts.map((p) => p.text).join(""));
      const explanationHtml = seg.explParts.map((p) => p.html).join("");
      const explanationText = seg.explParts.map((p) => p.text).join("");

      pageEntries.push({ quoteText, quoteHtml, explanationHtml, explanationText });

      flatSegments.push({
        id: segId++,
        sourceKey: "fengshan",
        tapeId: lesson.slug,
        pageSlug: lesson.slug,
        pageUrl: lesson.pageUrl,
        entryIndex: i,
        segmentIndex: 0,
        quoteText,
        quoteHtml,
        explanationHtml,
        explanationText,
        startSec: seg.startSec,
        endSec,
        audioPlan: [{ pageSlug: lesson.slug, startSec: seg.startSec, endSec }],
        audioUrl: lesson.audioUrl || undefined,
        originalTape: seg.originalTape || undefined,
        lessonSlug: lesson.slug,
        lessonTitle: lesson.lessonTitle,
      });
    }
    pages.push({
      slug: lesson.slug,
      pageUrl: lesson.pageUrl,
      tapeId: lesson.slug,
      entries: pageEntries,
    });
  }
  return { pages, flatSegments };
}

async function main() {
  process.stderr.write(`fetch index ${INDEX_URL}\n`);
  const indexHtml = await fetchText(INDEX_URL);
  const { lessons: all, tapeRanges } = parseIndex(indexHtml);
  if (!all.length) throw new Error("index: no lessons found");
  const end = Math.min(all.length, startLesson + maxLessons - 1);
  const picks = all.filter((x) => x.lessonNum >= startLesson && x.lessonNum <= end);
  process.stderr.write(`found ${all.length} lesson(s); building ${picks.length}; tape-ranges parsed: ${tapeRanges.length}\n`);

  const lessons = [];
  for (let i = 0; i < picks.length; i++) {
    const info = picks[i];
    process.stderr.write(`\rfetch lesson ${info.slug} (${i + 1}/${picks.length})   `);
    const html = await fetchText(info.pageUrl);
    lessons.push(parseLesson(html, info));
    if (delayMs > 0) await sleep(delayMs);
  }
  process.stderr.write("\n");

  const { pages, flatSegments } = buildFlatSegments(lessons);
  const builtSlugs = new Set(pages.map((p) => p.slug));
  const lessonTapeRanges = tapeRanges.filter((r) => builtSlugs.has(r.lessonSlug));
  const payload = {
    builtAt: new Date().toISOString(),
    source: INDEX_URL,
    sourceKey: "fengshan",
    pages,
    flatSegments,
    lessonTapeRanges,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const payloadJson = JSON.stringify(payload);
  fs.writeFileSync(OUT_GZ, zlib.gzipSync(Buffer.from(payloadJson, "utf8"), { level: 9 }));
  if (process.env.KEEP_FENGSHAN_JSON === "1") {
    fs.writeFileSync(OUT, payloadJson, "utf8");
  } else {
    try {
      fs.unlinkSync(OUT);
    } catch {
      /* ignore */
    }
  }
  console.log("Wrote", OUT_GZ, "lessons", pages.length, "flatSegments", flatSegments.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
