/**
 * Build Kepan (廣論章節科判) index from a local DOCX of the scripture and the
 * two existing transcript payloads. Assigns each FlatSegment (nanputuo/fengshan)
 * to a section by substring-matching its normalized quoteText against the
 * section's normalized bodyText.
 *
 * Output: public/data/lamrim-kepan.json.gz
 *
 * Usage:
 *   LAMRIM_KEPAN_DOCX="C:/path/to/…廣論…docx" node scripts/build-lamrim-kepan.mjs
 *   node scripts/build-lamrim-kepan.mjs --docx "C:/path/to/…廣論…docx"
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import JSZip from "jszip";
import * as cheerio from "cheerio";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lamrim-kepan.json");
const OUT_GZ = path.join(ROOT, "public", "data", "lamrim-kepan.json.gz");
const NP_GZ = path.join(ROOT, "public", "data", "lamrim-transcripts.json.gz");
const FG_GZ = path.join(ROOT, "public", "data", "fengshan-transcripts.json.gz");

const argv = process.argv.slice(2);
let docxPath = process.env.LAMRIM_KEPAN_DOCX || "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--docx" && argv[i + 1]) {
    docxPath = argv[i + 1];
    i++;
  } else {
    const m = a.match(/^--docx=(.+)$/);
    if (m) docxPath = m[1];
  }
}
if (!docxPath) {
  console.error("DOCX path required. Pass --docx <path> or LAMRIM_KEPAN_DOCX env.");
  process.exit(2);
}
if (!fs.existsSync(docxPath)) {
  console.error(`DOCX not found: ${docxPath}`);
  process.exit(2);
}

/**
 * 32 章節與傳統 6 組分組（與 plan 對齊）。
 * paraStart 僅用於偵錯／排序輔助；實際匹配以章節名字串在 DOCX 的標題出現點判定。
 */
const SECTION_ORDER = [
  { name: "歸敬頌",        group: 0 },
  { name: "造者殊勝",      group: 0 },
  { name: "教授殊勝",      group: 0 },
  { name: "聞說軌理",      group: 0 },
  { name: "親近善士",      group: 0 },
  { name: "修習軌理",      group: 0 },
  { name: "暇滿",          group: 0 },
  { name: "道次引導",      group: 0 },
  { name: "念死無常",      group: 1 },
  { name: "三惡趣苦",      group: 1 },
  { name: "歸依三寶",      group: 1 },
  { name: "深信業果",      group: 1 },
  { name: "希求解脫",      group: 2 },
  { name: "思惟苦諦",      group: 2 },
  { name: "思惟集諦",      group: 2 },
  { name: "十二緣起",      group: 2 },
  { name: "除邪分別",      group: 2 },
  { name: "解脫正道",      group: 2 },
  { name: "入大乘門",      group: 3 },
  { name: "菩提心次第",    group: 3 },
  { name: "儀軌受法",      group: 3 },
  { name: "學菩薩行",      group: 3 },
  { name: "布施波羅蜜多",  group: 3 },
  { name: "持戒波羅蜜多",  group: 3 },
  { name: "忍辱波羅蜜多",  group: 3 },
  { name: "精進波羅蜜多",  group: 3 },
  { name: "靜慮波羅蜜多",  group: 3 },
  { name: "般若波羅蜜多",  group: 3 },
  { name: "四攝法",        group: 3 },
  { name: "奢摩他",        group: 4 },
  { name: "毗缽舍那",      group: 4 },
  { name: "特學金剛乘法",  group: 5 },
];

const GROUPS = [
  { name: "道前基礎" },
  { name: "共下士道" },
  { name: "共中士道" },
  { name: "上士道" },
  { name: "別學止觀" },
  { name: "密乘" },
];

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function normalizeForMatch(s) {
  return (s || "").normalize("NFC").replace(/\s+/g, "");
}

async function readDocxParagraphs(pathname) {
  const buf = fs.readFileSync(pathname);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("document.xml not found in DOCX");
  const xml = await file.async("string");
  const $ = cheerio.load(xml, { xmlMode: true });
  const paras = [];
  $("w\\:p").each((_, el) => {
    const $p = $(el);
    const pPr = $p.children("w\\:pPr").first();
    let pStyle = null;
    let outlineLvl = null;
    if (pPr.length) {
      const ps = pPr.children("w\\:pStyle").first();
      if (ps.length) pStyle = ps.attr("w:val") || null;
      const ol = pPr.children("w\\:outlineLvl").first();
      if (ol.length) outlineLvl = ol.attr("w:val") || null;
    }
    let text = "";
    $p.find("w\\:t").each((_, t) => {
      text += $(t).text();
    });
    paras.push({ pStyle, outlineLvl, text });
  });
  return paras;
}

function isSectionHeading(p) {
  if (!p) return false;
  if (p.pStyle === "3") return true;
  if (p.outlineLvl === "2") return true;
  return false;
}

/**
 * 走訪 paragraphs，於「章節標題」邊界切段，合併各章節 body 至 concatenated 字串。
 * 以 SECTION_ORDER 逐條對齊：遇標題字串等於預期章名者，開下一章節；否則納入上一章。
 */
function buildSectionBodies(paras) {
  const sections = SECTION_ORDER.map((s, i) => ({
    index: i,
    name: s.name,
    group: s.group,
    paraStart: -1,
    paraEnd: -1,
    rawBody: "",
    body: "",
  }));

  let nextSectionIdx = 0;
  let currentSectionIdx = -1;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const txt = (p.text || "").trim();
    if (isSectionHeading(p) && nextSectionIdx < sections.length) {
      const expected = sections[nextSectionIdx].name;
      if (txt === expected) {
        if (currentSectionIdx >= 0) sections[currentSectionIdx].paraEnd = i - 1;
        currentSectionIdx = nextSectionIdx;
        sections[nextSectionIdx].paraStart = i;
        nextSectionIdx++;
        continue;
      }
    }
    if (currentSectionIdx >= 0) {
      // Append paragraph text; skip empty paragraphs to save space
      if (txt) sections[currentSectionIdx].rawBody += txt + "\n";
    }
  }
  if (currentSectionIdx >= 0 && sections[currentSectionIdx].paraEnd === -1) {
    sections[currentSectionIdx].paraEnd = paras.length - 1;
  }
  for (const s of sections) s.body = normalizeForMatch(s.rawBody);
  return sections;
}

function readTranscriptPayload(gzPath) {
  const buf = fs.readFileSync(gzPath);
  const json = zlib.gunzipSync(buf).toString("utf8");
  return JSON.parse(json);
}

/**
 * 對每個 segment 做匹配：
 *   1. quoteText 正規化長度 ≥ 5 → indexOf 於每章節 body；首個命中 → 記 section index
 *   2. 未命中者，沿用同頁／同講次前一已命中段落
 *   3. 仍未命中者，該段保留 unassigned（assignments 不含此 id）
 *
 * 統計每章節之命中數供偵錯。
 */
function assignSegments(segments, sections) {
  const assignment = {}; // id -> sectionIndex
  const unassignedIdx = [];
  // 長引文門檻：≥ 8 字元才直接吃章節首次命中；短於此者改走鄰居繼承，
  // 可避免「初中有四」「謂於彼等」等通用短句誤配後段章節。
  const MIN_DIRECT = 8;
  for (const seg of segments) {
    const q = normalizeForMatch(seg.quoteText || "");
    if (q.length >= MIN_DIRECT) {
      let hitIdx = -1;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].body.indexOf(q) >= 0) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        assignment[seg.id] = hitIdx;
        continue;
      }
    }
    unassignedIdx.push(seg);
  }

  // Inheritance pass: within same (sourceKey, pageSlug), pick the nearest
  // earlier segment that got assigned; fallback to nearest later if none earlier.
  const idxById = new Map(segments.map((s, i) => [s.id, i]));
  for (const seg of unassignedIdx) {
    const home = idxById.get(seg.id) ?? 0;
    let found = -1;
    for (let j = home - 1; j >= 0; j--) {
      const prev = segments[j];
      if (prev.pageSlug !== seg.pageSlug) break;
      if (assignment[prev.id] != null) {
        found = assignment[prev.id];
        break;
      }
    }
    if (found < 0) {
      for (let j = home + 1; j < segments.length; j++) {
        const nxt = segments[j];
        if (nxt.pageSlug !== seg.pageSlug) break;
        if (assignment[nxt.id] != null) {
          found = assignment[nxt.id];
          break;
        }
      }
    }
    if (found >= 0) assignment[seg.id] = found;
  }
  return assignment;
}

async function main() {
  process.stderr.write(`reading DOCX ${docxPath}\n`);
  const paras = await readDocxParagraphs(docxPath);
  process.stderr.write(`DOCX paragraphs: ${paras.length}\n`);

  const sections = buildSectionBodies(paras);
  const missing = sections.filter((s) => s.paraStart < 0);
  if (missing.length) {
    process.stderr.write(`WARN: ${missing.length} sections not located in DOCX: ${missing.map((s) => s.name).join(",")}\n`);
  }
  for (const s of sections) {
    process.stderr.write(`  [${String(s.index).padStart(2)}] ${s.name.padEnd(10)} para ${s.paraStart}…${s.paraEnd}  body=${s.body.length} chars\n`);
  }

  const npPayload = readTranscriptPayload(NP_GZ);
  const fgPayload = readTranscriptPayload(FG_GZ);
  process.stderr.write(`NP segments: ${npPayload.flatSegments.length}  FG segments: ${fgPayload.flatSegments.length}\n`);

  const npAssign = assignSegments(npPayload.flatSegments, sections);
  const fgAssign = assignSegments(fgPayload.flatSegments, sections);

  // Stats per section
  const perSectionNp = new Array(sections.length).fill(0);
  const perSectionFg = new Array(sections.length).fill(0);
  for (const v of Object.values(npAssign)) perSectionNp[v]++;
  for (const v of Object.values(fgAssign)) perSectionFg[v]++;
  const npMissing = npPayload.flatSegments.length - Object.keys(npAssign).length;
  const fgMissing = fgPayload.flatSegments.length - Object.keys(fgAssign).length;
  process.stderr.write(`\n=== Assignment stats ===\n`);
  for (let i = 0; i < sections.length; i++) {
    process.stderr.write(`  [${String(i).padStart(2)}] ${sections[i].name.padEnd(10)}  NP ${String(perSectionNp[i]).padStart(4)}  FG ${String(perSectionFg[i]).padStart(3)}\n`);
  }
  process.stderr.write(`Unassigned: NP ${npMissing}/${npPayload.flatSegments.length} · FG ${fgMissing}/${fgPayload.flatSegments.length}\n`);

  const payload = {
    builtAt: new Date().toISOString(),
    source: path.basename(docxPath),
    groups: GROUPS.map((g, i) => ({
      index: i,
      name: g.name,
      sectionIndexes: sections.filter((s) => s.group === i).map((s) => s.index),
    })),
    sections: sections.map((s) => ({
      index: s.index,
      name: s.name,
      group: s.group,
      paraStart: s.paraStart,
      paraEnd: s.paraEnd,
    })),
    assignments: {
      nanputuo: npAssign,
      fengshan: fgAssign,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(payload);
  fs.writeFileSync(OUT_GZ, zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 }));
  if (process.env.KEEP_KEPAN_JSON === "1") {
    fs.writeFileSync(OUT, json, "utf8");
  } else {
    try { fs.unlinkSync(OUT); } catch { /* ignore */ }
  }
  console.log(`Wrote ${OUT_GZ} (${Math.round(fs.statSync(OUT_GZ).size / 1024)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
