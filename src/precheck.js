'use strict';
// 上传预检：图幅识别、页数统计、字体缺失、未打印图层、尺寸比例核算
// 图纸文件为 JSON 描述（本地样本见 samples/），字段：
// { name, pages: [{ width_mm, height_mm, declared_scale, content_mm:{w,h}, fonts:[], layers:[{name,print}] }] }

const A_SIZES = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };
const AVAILABLE_FONTS = ['SimSun', 'SimHei', 'Arial', 'Times New Roman', 'GBCBIG'];
const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000, 1500, 2000];
const MM_TOLERANCE = 2;

function matchSheetSize(w, h) {
  for (const [name, [sw, sh]] of Object.entries(A_SIZES)) {
    const portrait = Math.abs(w - sw) <= MM_TOLERANCE && Math.abs(h - sh) <= MM_TOLERANCE;
    const landscape = Math.abs(w - sh) <= MM_TOLERANCE && Math.abs(h - sw) <= MM_TOLERANCE;
    if (portrait || landscape) return name;
  }
  return '非标准';
}

function parseScale(s) {
  const m = /^1\s*:\s*([\d.]+)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

function fmtScale(ratio) {
  // 可读数字：1:87.0 而不是 1:87.0386…
  const r = Math.round(ratio * 10) / 10;
  return `1:${Number.isInteger(r) ? r : r.toFixed(1)}`;
}

function inspectPage(page) {
  const missingFonts = (page.fonts || []).filter((f) => !AVAILABLE_FONTS.includes(f));
  const unprintedLayers = (page.layers || []).filter((l) => l.print === false).map((l) => l.name);

  const declared = parseScale(page.declared_scale);
  let scale = null;
  if (page.content_mm && page.content_mm.w > 0 && page.width_mm > 0) {
    const ax = page.content_mm.w / page.width_mm;
    const ay = page.content_mm.h / page.height_mm;
    const distorted = Math.abs(ax - ay) / Math.max(ax, ay) > 0.01; // 横纵比例不一致 = 拉伸变形
    const actual = Math.round(ax * 10) / 10;
    scale = {
      declared: declared ? `1:${declared}` : null,
      actual: fmtScale(ax),
      actual_ratio: actual,
      standard: STANDARD_SCALES.includes(Math.round(actual)),
      matches_declared: declared != null && Math.abs(declared - actual) / declared <= 0.02,
      distorted,
      ok: !distorted && declared != null && STANDARD_SCALES.includes(Math.round(actual)) &&
        Math.abs(declared - actual) / declared <= 0.02,
    };
  }
  return { missingFonts, unprintedLayers, scale };
}

// 返回该版本的完整预检报告（假定各页同图幅，以首页为准）
function inspectDrawing(drawing, requestedPaperSize) {
  if (!drawing || !Array.isArray(drawing.pages) || drawing.pages.length === 0) {
    const e = new Error('图纸文件缺少页面（pages 为空）');
    e.status = 422;
    throw e;
  }
  const first = drawing.pages[0];
  const sheetW = Number(first.width_mm);
  const sheetH = Number(first.height_mm);
  const sheetSize = matchSheetSize(sheetW, sheetH);

  const missingFonts = new Set();
  const unprintedLayers = new Set();
  const pageScales = [];
  drawing.pages.forEach((p, i) => {
    const r = inspectPage(p);
    r.missingFonts.forEach((f) => missingFonts.add(f));
    r.unprintedLayers.forEach((l) => unprintedLayers.add(l));
    if (r.scale) pageScales.push({ page: i + 1, ...r.scale });
  });

  const scaleProblem = pageScales.find((s) => !s.ok) || null;
  return {
    page_count: drawing.pages.length,
    sheet_w: sheetW,
    sheet_h: sheetH,
    sheet_size: sheetSize,
    paper_match: sheetSize === requestedPaperSize,
    requested_paper: requestedPaperSize,
    missing_fonts: [...missingFonts],
    unprinted_layers: [...unprintedLayers],
    page_scales: pageScales,
    scale_ok: scaleProblem == null,
    scale_problem: scaleProblem, // 第一个比例异常页，含可读的实际比例
  };
}

module.exports = { inspectDrawing, matchSheetSize, fmtScale, A_SIZES, AVAILABLE_FONTS, STANDARD_SCALES };
