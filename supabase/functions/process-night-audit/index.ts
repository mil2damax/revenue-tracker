import pako from "npm:pako@2.1.0";
import * as XLSX from "npm:xlsx@0.18.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── PDF text extraction ──────────────────────────────────────────────
// PDF bytes map 1:1 onto latin1 codepoints, so we can do all stream-finding
// as string regex work and convert back to bytes for decompression.

function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Decompress a single PDF stream. HotelKey streams are zlib (FlateDecode, `78 9c` header).
// Deno's native DecompressionStream is broken for these in the Edge Runtime
// ("failed to write whole buffer" / "corrupt deflate stream" for every combination
// of format + chunking we tried) — pako's pure-JS inflate works once the 2-byte
// zlib header is stripped and inflateRaw is used directly.
function decodeStream(raw: Uint8Array): string | null {
  if (raw.length >= 2 && raw[0] === 0x78) {
    try {
      const out = pako.inflateRaw(raw.subarray(2));
      return bytesToLatin1(out);
    } catch {
      // fall through to treat as uncompressed
    }
  }
  return bytesToLatin1(raw);
}

function extractPdfText(pdfBytes: Uint8Array): string {
  const pdfStr = bytesToLatin1(pdfBytes);
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  let combined = "";
  while ((m = streamRe.exec(pdfStr)) !== null) {
    const raw = latin1ToBytes(m[1]);
    const decoded = decodeStream(raw);
    if (decoded) combined += decoded + "\n";
  }
  const tokens: string[] = [];
  const tjRe = /\(([^)]{0,300})\)\s*Tj/g;
  while ((m = tjRe.exec(combined)) !== null) tokens.push(m[1]);
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

// ── XLSX extraction ───────────────────────────────────────────────────
// HotelKey's Excel exports are clean, cell-based grids — no positional
// reconstruction needed (unlike the PDF text stream). We read the first
// sheet as an array-of-rows of raw cell values.

function extractXlsxRows(bytes: Uint8Array): unknown[][] {
  // Concatenate all sheets — HotelKey exports are single-sheet, but Business
  // Track XLSX puts filters on "Request Details" and data on "Report (Page 1)".
  // SheetJS also parses CSV through this same entry point.
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const out: unknown[][] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    out.push(...(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as unknown[][]));
  }
  return out;
}

// Flatten all string cells into one blob for report-type detection (mirrors
// the PDF text-based detector so the same `detectReportType` can be reused).
function xlsxRowsToText(rows: unknown[][]): string {
  const parts: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell === "string" && cell.trim()) parts.push(cell.trim());
      else if (typeof cell === "number") parts.push(String(cell));
    }
  }
  return parts.join(" ");
}

// ── Report type detection ────────────────────────────────────────────

type ReportType =
  | "OPERA_FLASH"
  | "HOTEL_STATISTICS"
  | "AR_AGING"
  | "RATE_OVERRIDE"
  | "ADJUSTMENTS"
  | "AR_ACTIVITY"
  | "INHOUSE_BALANCES"
  | "TAX_REPORT"
  | "CLERK_ACTIVITY"
  | "USER_ACTIVITY"
  | "SETTLEMENTS"
  | "BUSINESS_TRACK"
  | "DISPLAY_ONLY"
  | "UNKNOWN";

function detectReportType(text: string): ReportType {
  if (/MANAGER FLASH|MANAGER - FLASH/i.test(text)) return "OPERA_FLASH";
  if (/HOTEL STATISTICS/i.test(text) && /ACTUAL TODAY/i.test(text)) return "HOTEL_STATISTICS";
  // "OVER 150" only appears in the PDF version's bucket headers; the Excel
  // export uses a different (finer) bucket set (Current/Over7/Over14/Over30/
  // Over60/Over90/Over120), so match on any "Over N" bucket header instead.
  if (/DIRECT BILL AGING/i.test(text) && /Over\s*\d/i.test(text)) return "AR_AGING";
  if (/RATE OVERRIDE/i.test(text)) return "RATE_OVERRIDE";
  if (/TAX REPORT/i.test(text)) return "TAX_REPORT";
  if (/CLERK ACTIVITY/i.test(text) && /Transaction Number/i.test(text)) return "CLERK_ACTIVITY";
  if (/ADJUSTMENTS AND REFUNDS/i.test(text)) return "ADJUSTMENTS";
  if (/Accounts Receivable Activity/i.test(text) && /Company Code/i.test(text)) return "AR_ACTIVITY";
  if (/IN HOUSE GUEST (FOLIO )?BALANCES/i.test(text)) return "INHOUSE_BALANCES";
  if (/User Activity Report/i.test(text) && /Confirmation Number/i.test(text)) return "USER_ACTIVITY";
  if (/SETTLEMENT BY PAYMENT TYPE/i.test(text)) return "SETTLEMENTS";
  // Fiserv Business Track "Settlement / Search" export (daily_settlement_report
  // .csv or manual .xlsx download) — column headers are the reliable signature.
  if (/Site ID \(BE\)/i.test(text) && /Processed Sales Amount/i.test(text)) return "BUSINESS_TRACK";
  if (/Tax Report|User Activity|Clerk Activity|Closed Folio/i.test(text)) return "DISPLAY_ONLY";
  return "UNKNOWN";
}

// Some Excel exports (Direct Bill Aging, Rate Override, Tax Report, Clerk
// Shift...) don't embed the report date as text on the sheet — HotelKey's
// filenames carry it instead (e.g. "06.04.26 Direct Bill Aging.xlsx" or
// "6.4.26 Rate Override.xlsx"). Fall back to parsing it from the filename.
function dateFromFilename(name: string): string | null {
  // Note: dateFromContentRows() is the companion fallback for PMS systems
  // (e.g. Hilton OnQ / RDURM) that embed "Date: MMM DD, YYYY" in cell content
  // but don't prefix their filenames with a date.
  const m = name.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  const month = mm.padStart(2, "0");
  const day = dd.padStart(2, "0");
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

// Scan all cells for "Date: MMM DD, YYYY" or "Date Range: MMM DD, YYYY - ..."
// (Hilton OnQ / RDURM embeds the report date in a header cell rather than in
// the filename, so we need this content-based fallback when the filename has
// no date prefix).
function dateFromContentRows(rows: unknown[][]): string | null {
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell !== "string") continue;
      // Matches "Date: Jun 26, 2026" and "Date Range: Jun 27, 2026 - ..."
      const m = cell.match(/Date(?:\s+Range)?:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
      if (m) return parseLongDate(m[1]);
    }
  }
  return null;
}

// ── Field parsing helpers ─────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseLongDate(s: string): string | null {
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  const day = m[2].padStart(2, "0");
  const month = String(mo).padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

function dollar(s: string): number {
  return parseFloat(s.replace(/[$,]/g, ""));
}

function pct(s: string): number {
  return parseFloat(s.replace(/[%\s]/g, ""));
}

function int(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10);
}

// ── HOTEL_STATISTICS → daily_revenue / monthly_revenue ────────────────
// Field mappings (confirmed):
//   occ_pct  = "Occupancy Including Out of Order Rooms, Comp, House Use Rooms"
//   adr      = "ADR Excluding Comp House Use Rooms"
//   revpar   = "RevPAR" (plain, not "RevPar With Out Of Order Rooms")
//   room_revenue  = Room Revenue section Totals  (Taxable + Exempt)
//   misc_revenue  = Other Revenue Totals + Misc Revenue Totals
//   total_revenue = grand Totals row (immediately after Misc Revenue Totals)
//
// Each labeled row on the report carries 5 columns: Actual Today | M-T-D | LY-M-T-D | Y-T-D | LY-T-D.
//
// Granularity rule:
//   - Reports dated before 2026-06-01: month-end snapshots, loaded as MONTHLY
//     records (M-T-D column) into monthly_revenue only — these represent whole,
//     finished months.
//   - Reports dated 2026-06-01 onward: loaded as DAILY records (Actual Today
//     column) into daily_revenue, AND the M-T-D column is upserted into
//     monthly_revenue for the in-progress month so History stays live all month
//     and finalizes naturally on the last day.

const DAILY_FROM = "2026-06-01";

const DOLLAR_VAL = String.raw`-?\$[\d,]+(?:\.\d+)?`;
const PCT_VAL = String.raw`[\d.]+\s*%`;
const INT_VAL = String.raw`\d[\d,]*`;

// Capture `n` consecutive same-shaped values immediately following a label.
function rowValues(text: string, labelSrc: string, valuePattern: string, n: number): string[] | null {
  const groups = Array(n).fill(`(${valuePattern})`).join(String.raw`\s+`);
  const re = new RegExp(`${labelSrc}\\s+${groups}`);
  const m = text.match(re);
  return m ? m.slice(1, n + 1) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface HotelStatsResult {
  date: string;
  granularity: "daily" | "monthly";
  dailyRow: Record<string, unknown> | null;   // → daily_revenue (Actual Today), only for "daily"
  monthlyRow: Record<string, unknown>;        // → monthly_revenue (M-T-D), always present
}

function parseHotelStatistics(text: string): HotelStatsResult | null {
  const dateM = text.match(/Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  const date = dateM ? parseLongDate(dateM[1]) : null;
  if (!date) return null;

  const granularity: "daily" | "monthly" = date >= DAILY_FROM ? "daily" : "monthly";

  const availRow = rowValues(text, String.raw`Rooms Available To\s*Sell`, INT_VAL, 3);
  const soldRow = rowValues(text, String.raw`\bRoom Sold`, INT_VAL, 3);
  const occRow = rowValues(
    text,
    String.raw`Occupancy Including\s*Out of Order Rooms,\s*Comp,\s*House Use\s*Rooms`,
    PCT_VAL,
    3,
  );
  const adrRow = rowValues(text, String.raw`ADR Excluding Comp\s*House Use Rooms`, DOLLAR_VAL, 3);
  const revparRow = rowValues(text, String.raw`\bRevPAR`, DOLLAR_VAL, 3);
  const roomRevRow = rowValues(text, String.raw`Room Revenue.*?Totals`, DOLLAR_VAL, 3);
  const otherRevRow = rowValues(text, String.raw`\bOther Revenue\b.*?Totals`, DOLLAR_VAL, 3);
  const miscGrandM = text.match(new RegExp(
    String.raw`Misc Revenue.*?Totals\s+(${DOLLAR_VAL})\s+(${DOLLAR_VAL})\s+(${DOLLAR_VAL}).*?Totals\s+(${DOLLAR_VAL})\s+(${DOLLAR_VAL})\s+(${DOLLAR_VAL})`,
  ));

  if (!availRow || !soldRow || !occRow || !adrRow || !revparRow || !roomRevRow || !miscGrandM) {
    return null;
  }

  // idx: 0 = Actual Today column, 1 = M-T-D column, 2 = LY-M-T-D column
  function fieldsAt(idx: 0 | 1 | 2) {
    const otherTotal = otherRevRow && otherRevRow[idx] != null ? dollar(otherRevRow[idx]) : 0;
    const miscSectionTotal = dollar(miscGrandM![1 + idx]);   // m[1]=misc today, m[2]=misc MTD, m[3]=misc LY-MTD
    const grandTotal = dollar(miscGrandM![4 + idx]);         // m[4]=grand today, m[5]=grand MTD, m[6]=grand LY-MTD
    return {
      rooms_available: int(availRow![idx]),
      rooms_sold: int(soldRow![idx]),
      occ_pct: pct(occRow![idx]),
      adr: dollar(adrRow![idx]),
      revpar: dollar(revparRow![idx]),
      room_revenue: dollar(roomRevRow![idx]),
      misc_revenue: round2(otherTotal + miscSectionTotal),
      total_revenue: grandTotal,
    };
  }

  const [y, m] = date.split("-");
  const periodStart = `${y}-${m}-01`;
  const periodEnd = granularity === "monthly" ? date : lastDayOfMonth(Number(y), Number(m));

  // LY-M-T-D — the report's own "this period last year" column. This is the only
  // reliable source for that figure (we have no day-by-day daily_revenue history
  // for prior years to reconstruct an equivalent "same days last year" total).
  const lyMtd = fieldsAt(2);

  const monthlyRow = {
    period_start: periodStart,
    period_end: periodEnd,
    source: "hotelkey_mtd",
    snapshot_date: date,
    ...fieldsAt(1),
    ly_mtd_room_revenue: lyMtd.room_revenue,
    ly_mtd_misc_revenue: lyMtd.misc_revenue,
    ly_mtd_total_revenue: lyMtd.total_revenue,
    ly_mtd_occ_pct: lyMtd.occ_pct,
    ly_mtd_adr: lyMtd.adr,
    ly_mtd_revpar: lyMtd.revpar,
  };

  const dailyRow = granularity === "daily" ? { date, ...fieldsAt(0) } : null;

  return { date, granularity, dailyRow, monthlyRow };
}

// ── HOTEL_STATISTICS (Excel) → daily_revenue / monthly_revenue / revenue_line_items
//
// HotelKey's Hotel Statistics .xlsx export is a single "Report" sheet of clean
// cell rows. Each labeled line carries 5 numeric columns in fixed positions:
//   col B = label, cols C–G = Actual Today | M-T-D | LY-M-T-D | Y-T-D | LY-T-D
// Section/subsection titles are label-only rows (no numeric columns); "Totals"
// rows have an empty-string label with the 5 numeric columns filled in. This
// is a vastly more reliable source than the PDF text stream — real numeric
// cells, zero positional ambiguity — and additionally exposes every Misc
// Revenue / Tax / Payment line item individually (impossible to parse from the
// PDF, where all labels are emitted as one block and all values as another).

interface XlsxLineItem {
  section: string;
  label: string;
  vals: [number, number, number, number, number];
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.replace(/[$,%\s]/g, "");
    if (s === "" || isNaN(Number(s))) return null;
    return Number(s);
  }
  return null;
}

interface HotelStatsXlsxResult extends HotelStatsResult {
  lineItems: XlsxLineItem[];
}

function parseHotelStatisticsXlsx(rows: unknown[][]): HotelStatsXlsxResult | null {
  // Locate "Date: <Month DD, YYYY>" wherever it appears on the sheet.
  let date: string | null = null;
  outer: for (const row of rows) {
    for (const cell of row) {
      if (typeof cell === "string") {
        const m = cell.match(/Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
        if (m) { date = parseLongDate(m[1]); break outer; }
      }
    }
  }
  if (!date) return null;

  const granularity: "daily" | "monthly" = date >= DAILY_FROM ? "daily" : "monthly";

  // Walk rows, tracking the current section/subsection title (the most recent
  // label-only row) and collecting every fully-numeric labeled row as an item.
  let group = "";
  const items: XlsxLineItem[] = [];
  for (const row of rows) {
    const rawLabel = row[1];
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    const vals = [row[2], row[3], row[4], row[5], row[6]].map(toNum);
    const allNumeric = vals.length === 5 && vals.every((v) => v !== null);
    // Activity-count rows (No Shows, Walk Ins, Cancellations, etc.) skip the LY-MTD
    // column, so allNumeric fails. Accept any row where Today (vals[0]) is present.
    const hasToday = vals[0] !== null;

    if (allNumeric || hasToday) {
      items.push({ section: group, label: label || "Totals", vals: vals.map((v) => v ?? 0) as [number, number, number, number, number] });
    } else if (label && label !== "Description") {
      group = label;
    }
  }

  const find = (pred: (label: string, section: string) => boolean) =>
    items.find((it) => pred(it.label, it.section));
  const findIndex = (pred: (label: string, section: string) => boolean) =>
    items.findIndex((it) => pred(it.label, it.section));

  const availItem    = find((l) => /Rooms Available To\s*Sell/i.test(l));
  const soldItem     = find((l) => /\bRooms?\s+Sold\b/i.test(l));
  // HotelKey: "Occupancy Including Out of Order Rooms, Comp, House Use Rooms"
  // Hilton OnQ (RDURM): "OCCUPANCY INCLUDING DOWN, COMP, HOUSE USE ROOMS"
  const occItem      = find((l) => /^Occupancy Including/i.test(l));
  const adrItem      = find((l) => /ADR Excluding Comp/i.test(l));
  const revparItem   = find((l) => /^RevPAR$/i.test(l));
  const roomRevItem  = find((l, s) => l === "Totals" && /Room Revenue/i.test(s));
  const otherRevItem = find((l, s) =>
    (l === "Totals" && /^Other Revenue$/i.test(s)) || /^Other Revenue$/i.test(l));
  const miscRevIdx   = findIndex((l, s) => l === "Totals" && /Misc Revenue/i.test(s));
  const miscRevItem  = miscRevIdx >= 0 ? items[miscRevIdx] : undefined;

  // Room statistics — additional fields
  const totalRoomsItem  = find((l) => /^Total Rooms$/i.test(l));
  const oooItem         = find((l) => /^Out Of Order$/i.test(l));
  const compItem        = find((l) => /^Comp Rooms$/i.test(l));
  const houseItem       = find((l) => /^House Rooms$/i.test(l));
  const noShowItem      = find((l) => /^No Shows?$/i.test(l));
  const walkInItem      = find((l) => /^Walk Ins?$/i.test(l));
  const cancItem        = find((l) => /^Cancellation for Today/i.test(l));
  // HotelKey: "Tomorrows Arrivals" — Hilton OnQ: "TOMORROW'S ARRIVALS"
  const tmrArrItem      = find((l) => /^Tomorrow'?s?\s+Arrivals?$/i.test(l));
  const tmrDepItem      = find((l) => /^Tomorrow'?s?\s+Departures?$/i.test(l));

  // Grand total = the Totals row immediately following Misc Revenue's totals
  // (mirrors the PDF's "Misc Revenue ... Totals ... Totals" pattern).
  let grandItem: XlsxLineItem | undefined;
  if (miscRevIdx >= 0 && items[miscRevIdx + 1]?.label === "Totals") {
    grandItem = items[miscRevIdx + 1];
  } else {
    const otherIdx = findIndex((l, s) =>
      (l === "Totals" && /^Other Revenue$/i.test(s)) || /^Other Revenue$/i.test(l));
    if (otherIdx >= 0 && items[otherIdx + 1]?.label === "Totals") grandItem = items[otherIdx + 1];
  }

  if (!availItem || !soldItem || !occItem || !adrItem || !revparItem || !roomRevItem || !grandItem) {
    return null;
  }

  function fieldsAt(idx: 0 | 1 | 2) {
    const otherTotal = otherRevItem ? otherRevItem.vals[idx] : 0;
    const miscTotal = miscRevItem ? miscRevItem.vals[idx] : 0;
    return {
      rooms_available: Math.round(availItem!.vals[idx]),
      rooms_sold: Math.round(soldItem!.vals[idx]),
      // Excel stores occupancy as a fraction (e.g. 0.9011); the rest of the
      // schema (and the PDF parser via pct()) expects a percentage (90.11).
      occ_pct: round2(occItem!.vals[idx] * 100),
      adr: adrItem!.vals[idx],
      revpar: revparItem!.vals[idx],
      room_revenue: roomRevItem!.vals[idx],
      misc_revenue: round2(otherTotal + miscTotal),
      total_revenue: grandItem!.vals[idx],
    };
  }

  // Room stats are daily-only — point-in-time counts that don't aggregate into monthly totals
  const dailyRoomStats = {
    rooms_total:         totalRoomsItem ? Math.round(totalRoomsItem.vals[0]) : null,
    rooms_ooo:           oooItem        ? Math.round(oooItem.vals[0])        : null,
    rooms_comp:          compItem       ? Math.round(compItem.vals[0])       : null,
    rooms_house:         houseItem      ? Math.round(houseItem.vals[0])      : null,
    no_shows:            noShowItem     ? Math.round(noShowItem.vals[0])     : null,
    walk_ins:            walkInItem     ? Math.round(walkInItem.vals[0])     : null,
    cancellations:       cancItem       ? Math.round(cancItem.vals[0])       : null,
    tomorrow_arrivals:   tmrArrItem     ? Math.round(tmrArrItem.vals[0])     : null,
    tomorrow_departures: tmrDepItem     ? Math.round(tmrDepItem.vals[0])     : null,
  };

  const [y, m] = date.split("-");
  const periodStart = `${y}-${m}-01`;
  const periodEnd = granularity === "monthly" ? date : lastDayOfMonth(Number(y), Number(m));
  const lyMtd = fieldsAt(2);

  const monthlyRow = {
    period_start: periodStart,
    period_end: periodEnd,
    source: "hotelkey_xlsx_mtd",
    snapshot_date: date,
    ...fieldsAt(1),
    ly_mtd_room_revenue: lyMtd.room_revenue,
    ly_mtd_misc_revenue: lyMtd.misc_revenue,
    ly_mtd_total_revenue: lyMtd.total_revenue,
    ly_mtd_occ_pct: lyMtd.occ_pct,
    ly_mtd_adr: lyMtd.adr,
    ly_mtd_revpar: lyMtd.revpar,
  };

  const dailyRow = granularity === "daily" ? { date, ...fieldsAt(0), ...dailyRoomStats } : null;

  // Keep only the genuinely useful drill-down detail — individual line items
  // within Misc Revenue / Taxes / Payments / Fee sections (skip the summary
  // "Totals" rows already captured above, and skip Room/Performance Statistics
  // which the existing summary fields already cover).
  const lineItems = items
    .filter((it) => it.label !== "Totals" && /Misc Revenue|Taxes?|Payments?|Fee/i.test(it.section))
    .map((it) => ({ section: it.section, label: it.label, vals: it.vals }));

  return { date, granularity, dailyRow, monthlyRow, lineItems };
}

// ── DIRECT BILL AGING (Excel) → ar_aging ──────────────────────────────
// Sectioned tables: "Accounts Receivables" / "Invoices" / "Settlements", each
// listing  Company Name | Company Code | Current | Over7 | Over14 | Over30 |
// Over60 | Over90,  followed by an unlabeled subtotal row. We keep one row
// per company per section (skipping the subtotal rows — they're derivable).

interface ArAgingRow {
  category: string;
  company: string;
  current_bal: number;
  over_7: number;
  over_14: number;
  over_30: number;
  over_60: number;
  over_90: number;
  over_120: number;
  over_150: number;
  total: number;
}

function parseDirectBillAgingXlsx(rows: unknown[][]): ArAgingRow[] | null {
  // Column positions vary by section and by PMS system:
  //   HotelKey (WKFCW): Current|Over7|Over14|Over30|Over60|Over90|Over120|Over150|Total
  //   Hilton OnQ (RDURM) Accounts Receivables: Current|Over30|Over60|Over90|Over120|Over150|Total (no Over7/Over14)
  //   Hilton OnQ (RDURM) Invoices: Current|Over7|Over14|Over30|Over60|Over90|Over120|Over150|Total
  // We detect column positions from each section's own header row instead of using fixed offsets.
  const SECTION_NAMES = new Set(["Accounts Receivables", "Invoices", "Settlements"]);
  // Rollup sections whose rows duplicate the detail above — skip entirely
  // (HotelKey added "Summary By Company" mid-July 2026).
  const SKIP_SECTIONS = new Set(["Summary By Company", "Totals"]);
  let category = "";
  type ColMap = { cur: number; o7: number; o14: number; o30: number; o60: number; o90: number; o120: number; o150: number; total: number };
  let colMap: ColMap | null = null;
  const out: ArAgingRow[] = [];

  for (const row of rows) {
    const label = typeof row[1] === "string" ? row[1].trim() : "";
    if (SECTION_NAMES.has(label)) { category = label; colMap = null; continue; }
    if (SKIP_SECTIONS.has(label)) { category = ""; colMap = null; continue; }
    if (!category) continue;

    // Per-section header row: detect column indices by name
    if (label === "Company Name") {
      const h = (i: number) => {
        const v = typeof row[i] === "string" ? (row[i] as string).trim().toLowerCase() : "";
        return v.replace(/\s+days?$/i, "").replace(/\s+/g, "");
      };
      colMap = { cur: -1, o7: -1, o14: -1, o30: -1, o60: -1, o90: -1, o120: -1, o150: -1, total: -1 };
      for (let i = 2; i < row.length; i++) {
        const k = h(i);
        if (k === "current")  colMap.cur   = i;
        else if (k === "over7")   colMap.o7    = i;
        else if (k === "over14")  colMap.o14   = i;
        else if (k === "over30")  colMap.o30   = i;
        else if (k === "over60")  colMap.o60   = i;
        else if (k === "over90")  colMap.o90   = i;
        else if (k === "over120") colMap.o120  = i;
        else if (k === "over150") colMap.o150  = i;
        else if (k === "total")   colMap.total = i;
      }
      continue;
    }

    if (!label || !colMap || colMap.cur < 0) continue;

    const g = (i: number) => i >= 0 ? (toNum(row[i]) ?? 0) : 0;
    const cur  = g(colMap.cur);
    const o7   = g(colMap.o7);
    const o14  = g(colMap.o14);
    const o30  = g(colMap.o30);
    const o60  = g(colMap.o60);
    const o90  = g(colMap.o90);
    const o120 = g(colMap.o120);
    const o150 = g(colMap.o150);
    const rptTotal = colMap.total >= 0 ? toNum(row[colMap.total]) : null;
    const total = rptTotal ?? round2(cur + o7 + o14 + o30 + o60 + o90 + o120 + o150);

    out.push({ category, company: label, current_bal: cur, over_7: o7, over_14: o14, over_30: o30, over_60: o60, over_90: o90, over_120: o120, over_150: o150, total });
  }
  return out.length ? out : null;
}

// ── RATE OVERRIDE (Excel) → rate_overrides ────────────────────────────
// Full table — columns (0-based row index):
//  1 Modification Date | 2 Stay Date | 3 Time | 4 Confirmation Number |
//  5 Check In Date | 6 Check Out Date | 7 Guest Name | 8 Adults | 9 Children |
//  10 Room Nights | 11 Room Number | 12 Room Type | 13 Charge Type |
//  14 Adjustment Code | 15 Sold Rate | 16 New Rate | 17 Rate Plan |
//  18 Market Segment | 19 Override Amount | 20 Username | 21 Override Reason
// (The PDF version only exposed a subset of these — the Excel export is the
// richer source and lines up with the existing `rate_overrides` schema.)

interface RateOverrideRow {
  modification_date: string | null;
  stay_date: string | null;
  confirmation_no: string;
  guest_name: string;
  check_in: string | null;
  check_out: string | null;
  room_number: string;
  room_type: string;
  sold_rate: number | null;
  new_rate: number | null;
  override_amount: number | null;
  rate_plan: string;
  market_segment: string;
  username: string;
  override_reason: string;
}

function excelDateToIso(v: unknown): string | null {
  if (v instanceof Date) {
    const y = v.getUTCFullYear(), m = v.getUTCMonth() + 1, d = v.getUTCDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : (v == null ? "" : String(v));
}

function parseRateOverrideXlsx(rows: unknown[][]): RateOverrideRow[] | null {
  const out: RateOverrideRow[] = [];
  let inTable = false;
  // Mid-July 2026 HotelKey inserted "First Name"/"Last Name" after Guest Name,
  // shifting later columns by 2 — detect per file from the header row.
  let o = 0;
  for (const row of rows) {
    const label = typeof row[1] === "string" ? row[1].trim() : "";
    if (label === "Modification Date") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inTable = true; continue;
    }
    if (label === "END OF REPORT") break;
    if (!inTable) continue;
    const idx = row[0];
    if (typeof idx !== "number") continue; // skip blank/subtotal rows
    out.push({
      modification_date: excelDateToIso(row[1]),
      stay_date: excelDateToIso(row[2]),
      confirmation_no: strOf(row[4]),
      check_in: excelDateToIso(row[5]),
      check_out: excelDateToIso(row[6]),
      guest_name: strOf(row[7]),
      room_number: strOf(row[11 + o]),
      room_type: strOf(row[12 + o]),
      sold_rate: toNum(row[15 + o]),
      new_rate: toNum(row[16 + o]),
      rate_plan: strOf(row[17 + o]),
      market_segment: strOf(row[18 + o]),
      override_amount: toNum(row[19 + o]),
      username: strOf(row[20 + o]),
      override_reason: strOf(row[21 + o]),
    });
  }
  return out.length ? out : null;
}

// ── TAX REPORT (Excel) → tax_summary ───────────────────────────────────
// Clean Summary section: Tax Name | Total Revenue | Exempted Revenue |
// Taxable Payable | Payable Tax | Exempted Tax  (Occupancy Tax, Sales Tax
// rows + an unlabeled grand-total row, which we skip — derivable by summing).

interface TaxSummaryRow {
  tax_name: string;
  total_revenue: number;
  exempted_revenue: number;
  taxable_payable: number;
  payable_tax: number;
  exempted_tax: number;
}

function parseTaxReportXlsx(rows: unknown[][]): TaxSummaryRow[] | null {
  const out: TaxSummaryRow[] = [];
  let inSummary = false;
  for (const row of rows) {
    const label = typeof row[1] === "string" ? row[1].trim() : "";
    if (label === "Summary") { inSummary = true; continue; }
    if (inSummary && label === "Tax Name") continue;
    if (inSummary && label && label !== "") {
      const vals = [row[2], row[3], row[4], row[5], row[6]].map(toNum);
      if (vals.length === 5 && vals.every((v) => v !== null)) {
        const [tot, exRev, taxPay, payTax, exTax] = vals as number[];
        out.push({ tax_name: label, total_revenue: tot, exempted_revenue: exRev, taxable_payable: taxPay, payable_tax: payTax, exempted_tax: exTax });
      }
    } else if (inSummary && label === "" ) {
      break; // hit the grand-total row — end of Summary section
    }
  }
  return out.length ? out : null;
}

// ── CLERK ACTIVITY (Excel) → clerk_activity
// One clean transaction-level table:
//   # | Date | Time | Transaction Number | Group Name | Name | Company | Room Number |
//   Username | Amount | Department Code | Department Name | GL Account Code |
//   GL Account Name | Payment Type | Payment Detail
// (the "Username" column is the clerk who processed each transaction — the name
// in the report header, e.g. "Patel Milan", is just whoever *ran* the report.)
// A trailing "Summary" sub-table (Username | Payment Type | Total Amount) is a
// pure rollup of the detail rows above, so we skip it to avoid double-counting.

interface ClerkActivityRow {
  row_number: number | null;
  date: string | null;
  time: string | null;
  transaction_number: string;
  group_name: string;
  guest_name: string;
  company: string;
  room_number: string;
  username: string;
  amount: number | null;
  department_code: string;
  department_name: string;
  gl_account_code: string;
  gl_account_name: string;
  payment_type: string;
  payment_detail: string;
}

function excelTimeToString(v: unknown): string | null {
  if (v instanceof Date) {
    const h = v.getUTCHours(), m = v.getUTCMinutes(), s = v.getUTCSeconds();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return null;
}

function parseClerkActivityXlsx(rows: unknown[][]): ClerkActivityRow[] | null {
  const out: ClerkActivityRow[] = [];
  let inDetail = false;
  // Mid-July 2026 layout change: "First Name"/"Last Name" inserted after Name
  let o = 0;

  for (const row of rows) {
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    if (col1 === "Date") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inDetail = true; continue;
    }
    if (col1 === "Summary") break; // stop before the rollup sub-table
    if (!inDetail) continue;
    if (typeof row[0] !== "number") continue; // skip blank rows

    out.push({
      row_number: typeof row[0] === "number" ? row[0] : null,
      date: excelDateToIso(row[1]),
      time: excelTimeToString(row[2]),
      transaction_number: strOf(row[3]),
      group_name: strOf(row[4]),
      guest_name: strOf(row[5]),
      company: strOf(row[6 + o]),
      room_number: strOf(row[7 + o]),
      username: strOf(row[8 + o]),
      amount: toNum(row[9 + o]),
      department_code: strOf(row[10 + o]),
      department_name: strOf(row[11 + o]),
      gl_account_code: strOf(row[12 + o]),
      gl_account_name: strOf(row[13 + o]),
      payment_type: strOf(row[14 + o]),
      payment_detail: strOf(row[15 + o]),
    });
  }

  return out.length ? out : null;
}

// ── AR ACTIVITY (Excel) → ar_activity ────────────────────────────────
// Full transaction-level AR ledger — one row per reservation charge.
// Sections: "Accounts Receivable" (main), possibly others.
// Header: Date | Company Name | Company Code | Transaction Type |
//   Transaction Number | Name | Check In Date | Check Out Date |
//   Current | 31 to 60 | 61 to 90 | 91 to 120 | 121 to 150 | Over 150 |
//   Amount | Transaction Status
// Each file is a full snapshot of ALL outstanding AR as of that date.

interface ArActivityRow {
  row_number: number;
  transaction_date: string | null;
  company_name: string;
  company_code: string;
  transaction_type: string;
  transaction_number: string;
  guest_name: string;
  check_in_date: string | null;
  check_out_date: string | null;
  current_bal: number;
  over_30: number;
  over_60: number;
  over_90: number;
  over_120: number;
  over_150: number;
  amount: number | null;
  transaction_status: string;
}

function parseArActivityXlsx(rows: unknown[][]): ArActivityRow[] | null {
  const out: ArActivityRow[] = [];
  let inDetail = false;

  for (const row of rows) {
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    if (col1 === "Date") { inDetail = true; continue; }
    if (!inDetail) continue;
    if (typeof row[0] !== "number") continue;

    out.push({
      row_number: row[0] as number,
      transaction_date: excelDateToIso(row[1]),
      company_name: strOf(row[2]),
      company_code: strOf(row[3]),
      transaction_type: strOf(row[4]),
      transaction_number: strOf(row[5]),
      guest_name: strOf(row[6]),
      check_in_date: excelDateToIso(row[7]),
      check_out_date: excelDateToIso(row[8]),
      current_bal: toNum(row[9]) ?? 0,
      over_30: toNum(row[10]) ?? 0,
      over_60: toNum(row[11]) ?? 0,
      over_90: toNum(row[12]) ?? 0,
      over_120: toNum(row[13]) ?? 0,
      over_150: toNum(row[14]) ?? 0,
      amount: toNum(row[15]),
      transaction_status: strOf(row[16]),
    });
  }

  return out.length ? out : null;
}

// ── ADJUSTMENTS ACTIVITY (Excel) → adjustments_activity ──────────────
// One row per adjustment/refund event.
// Header: Date | Time | Transaction Type | Charge Type | Transaction Name |
//   Transaction Number | Room Number | Adjustment Reason Code |
//   Adjusted Amount | Adjusted Tax | Transferred Charge | Transferred Tax |
//   Username | Remarks

interface AdjustmentsRow {
  section: string;
  row_number: number;
  date: string | null;
  time: string | null;
  transaction_type: string;
  charge_type: string;
  guest_name: string;
  transaction_number: string;
  room_number: string;
  adjustment_reason: string;
  adjusted_amount: number;
  adjusted_tax: number;
  transferred_charge: number;
  transferred_tax: number;
  username: string;
  remarks: string;
}

// Section names that contain detail rows (skip Summary sections which are rollups)
const ADJ_DETAIL_SECTIONS = ["Adjustments", "Manager Charge Adjustments", "Refunds", "Manager Refund"];

const ADJ_SKIP_SECTIONS = ["Adjustment Summary", "Refund Summary"];
const ADJ_ALL_SECTIONS = [...ADJ_DETAIL_SECTIONS, ...ADJ_SKIP_SECTIONS];

function parseAdjustmentsXlsx(rows: unknown[][]): AdjustmentsRow[] | null {
  // Each section has DIFFERENT column counts — must map per-section.
  //
  // Adjustments (14 data cols + row#):
  //   0:#  1:Date  2:Time  3:TxType  4:ChargeType  5:GuestName/TxName  6:TxNumber
  //   7:Room  8:ReasonCode  9:Amount  10:Tax  11:TransCharge  12:TransTax  13:Username  14:Remarks
  //
  // Manager Charge Adjustments (11 data cols + row#, NO reason code):
  //   0:#  1:Date  2:Time  3:TxType  4:ChargeType  5:TxName(GuestName)  6:TxNumber
  //   7:Room  8:Amount  9:Tax  10:Username  11:Remarks
  //
  // Refunds (12 data cols, null at col0 but row# present in data rows):
  //   0:#  1:Date  2:Time  3:TxType  4:TxName(GuestName)  5:TxNumber  6:Room
  //   7:PaymentDetail  8:RefundCode(Reason)  9:PayTypeRefunded  10:Amount  11:Username  12:Remarks
  //
  // Manager Refund (11 data cols, null at col0 but row# in data rows):
  //   0:#  1:Date  2:Time  3:TxNumber  4:TxType  5:TxName(GuestName)  6:Room
  //   7:PayTypeRefunded  8:PaymentDetail  9:Amount  10:Username  11:Remarks

  const out: AdjustmentsRow[] = [];
  let section = "";
  let inDetail = false;
  // Mid-July 2026 HotelKey inserted "First Name" and "Last Name" columns after
  // Transaction Name in every section, shifting later columns by 2. Detect per
  // section from its header row so both layouts parse.
  let o = 0;

  for (const row of rows) {
    const col0 = typeof row[0] === "string" ? row[0].trim() : "";
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    const sectionCandidate = ADJ_ALL_SECTIONS.find(s => s === col0 || s === col1);

    if (sectionCandidate) {
      if (ADJ_SKIP_SECTIONS.includes(sectionCandidate)) {
        section = ""; inDetail = false;
      } else {
        section = sectionCandidate; inDetail = false;
      }
      continue;
    }
    if (!section) continue;
    if (col1 === "Date" || col0 === "Date" || col1 === "Type" || col0 === "Type") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inDetail = true; continue;
    }
    if (!inDetail || typeof row[0] !== "number") continue;

    if (section === "Adjustments") {
      out.push({
        section, row_number: row[0] as number,
        date: excelDateToIso(row[1]), time: excelTimeToString(row[2]),
        transaction_type: strOf(row[3]), charge_type: strOf(row[4]),
        guest_name: strOf(row[5]), transaction_number: strOf(row[6 + o]),
        room_number: strOf(row[7 + o]), adjustment_reason: strOf(row[8 + o]),
        adjusted_amount: toNum(row[9 + o]) ?? 0, adjusted_tax: toNum(row[10 + o]) ?? 0,
        transferred_charge: toNum(row[11 + o]) ?? 0, transferred_tax: toNum(row[12 + o]) ?? 0,
        username: strOf(row[13 + o]), remarks: strOf(row[14 + o]),
      });
    } else if (section === "Manager Charge Adjustments") {
      // No reason code column — amount shifts left to col 8
      out.push({
        section, row_number: row[0] as number,
        date: excelDateToIso(row[1]), time: excelTimeToString(row[2]),
        transaction_type: strOf(row[3]), charge_type: strOf(row[4]),
        guest_name: strOf(row[5]), transaction_number: strOf(row[6 + o]),
        room_number: strOf(row[7 + o]), adjustment_reason: "",
        adjusted_amount: toNum(row[8 + o]) ?? 0, adjusted_tax: toNum(row[9 + o]) ?? 0,
        transferred_charge: 0, transferred_tax: 0,
        username: strOf(row[10 + o]), remarks: strOf(row[11 + o]),
      });
    } else if (section === "Refunds") {
      // GuestName at col4 (Transaction Name); later columns shift with layout
      out.push({
        section, row_number: row[0] as number,
        date: excelDateToIso(row[1]), time: excelTimeToString(row[2]),
        transaction_type: strOf(row[3]),
        charge_type: strOf(row[7 + o]),      // Payment Detail (e.g. "VISA 7310")
        guest_name: strOf(row[4]),            // Transaction Name = guest name
        transaction_number: strOf(row[5 + o]),
        room_number: strOf(row[6 + o]),
        adjustment_reason: strOf(row[8 + o]), // Refund Code (e.g. "CUSTOMER SATISFACTION")
        adjusted_amount: toNum(row[10 + o]) ?? 0,
        adjusted_tax: 0,
        transferred_charge: 0, transferred_tax: 0,
        username: strOf(row[11 + o]), remarks: strOf(row[12 + o]),
      });
    } else if (section === "Manager Refund") {
      // TxNumber at col3, GuestName at col5; later columns shift with layout
      out.push({
        section, row_number: row[0] as number,
        date: excelDateToIso(row[1]), time: excelTimeToString(row[2]),
        transaction_type: strOf(row[4]),
        charge_type: strOf(row[8 + o]),       // Payment Detail
        guest_name: strOf(row[5]),             // Transaction Name = guest name
        transaction_number: strOf(row[3]),
        room_number: strOf(row[6 + o]),
        adjustment_reason: strOf(row[7 + o]), // Payment Type Refunded
        adjusted_amount: toNum(row[9 + o]) ?? 0,
        adjusted_tax: 0,
        transferred_charge: 0, transferred_tax: 0,
        username: strOf(row[10 + o]), remarks: strOf(row[11 + o]),
      });
    }
  }

  return out;
}

// ── IN-HOUSE GUEST BALANCES (Excel) → inhouse_balances ───────────────
// HotelKey (WKFCW) columns (0-based, after "Room Number" header row):
//   0:# 1:RoomNumber 2:GuestName 3:GuestTier 4:ArrivalDate 5:DepartureDate
//   6:RoomRate 7:FolioName(Company) 8:FolioBalance 9:CreditBalance
//   10:OutstandingBalance 11:PaymentMethod 12:AvailableCreditLimit 13:AutoTopOff
//
// Hilton OnQ (RDURM) columns (0-based, after "Confirmation Number" header row):
//   0:# 1:ConfirmationNumber 2:GroupCode 3:RoomNumber 4:GuestName
//   5:AddnGuests 6:CompanyName 7:CheckInDate 8:CheckOutDate 9:RatePlan
//   10:PaymentMethod 11:Status 12:TodaysCharges 13:TodaysPayments
//   14:TodaysOpeningBalance 15:TodaysNetChange 16:TodaysEndingBalance

interface InhouseRow {
  room_number: string; guest_name: string; company: string;
  arrival_date: string | null; departure_date: string | null;
  room_rate: number; folio_balance: number;
  payment_method: string; credit_limit: number;
}

function parseInhouseXlsx(rows: unknown[][]): InhouseRow[] | null {
  const out: InhouseRow[] = [];
  let inDetail = false;
  let isRdurm = false;

  // Mid-July 2026 HotelKey layout change: "First Name"/"Last Name" inserted after Guest Name
  let o = 0;
  for (const row of rows) {
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    // HotelKey header trigger
    if (col1 === "Room Number") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inDetail = true; isRdurm = false; continue;
    }
    // Hilton OnQ header trigger
    if (col1 === "Confirmation Number") { inDetail = true; isRdurm = true; continue; }
    if (!inDetail) continue;
    if (typeof row[0] !== "number") continue;

    if (isRdurm) {
      out.push({
        room_number:    strOf(row[3]),
        guest_name:     strOf(row[4]),
        company:        strOf(row[6]),
        arrival_date:   excelDateToIso(row[7]),
        departure_date: excelDateToIso(row[8]),
        room_rate:      0,                        // not in Hilton OnQ report
        folio_balance:  toNum(row[16]) ?? 0,      // Today's Ending Balance
        payment_method: strOf(row[10]),
        credit_limit:   0,                        // not in Hilton OnQ report
      });
    } else {
      out.push({
        room_number:    strOf(row[1]),
        guest_name:     strOf(row[2]),
        company:        strOf(row[7 + o]),
        arrival_date:   excelDateToIso(row[4 + o]),
        departure_date: excelDateToIso(row[5 + o]),
        room_rate:      toNum(row[6 + o]) ?? 0,
        folio_balance:  toNum(row[8 + o]) ?? 0,
        payment_method: strOf(row[11 + o]),
        credit_limit:   toNum(row[12 + o]) ?? 0,
      });
    }
  }
  return out.length ? out : null;
}

// ── USER ACTIVITY (Excel) → user_activity ────────────────────────────
// One row per PMS reservation modification event.
// Columns: #(0) | Date(1) | Time(2) | User(3) | Confirmation#(4) | Guest(5) |
//   CheckInDateTime(6) | CheckOutDateTime(7) | Room#(8) | Action(9) |
//   PreviousValue(10) | CurrentValue(11) | Remarks(12)

function excelDateTimeToIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return null;
}

interface UserActivityRow {
  row_number: number;
  time: string | null;
  username: string;
  confirmation_number: string;
  guest_name: string;
  check_in_datetime: string | null;
  check_out_datetime: string | null;
  room_number: string;
  action: string;
  previous_value: string;
  current_value: string;
  remarks: string;
}

function parseUserActivityXlsx(rows: unknown[][]): UserActivityRow[] | null {
  const out: UserActivityRow[] = [];
  let inDetail = false;
  // Mid-July 2026 layout change: "First Name"/"Last Name" inserted after Guest Name
  let o = 0;

  for (const row of rows) {
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    // Column header row
    if (col1 === "Date") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inDetail = true; continue;
    }
    if (!inDetail) continue;
    if (typeof row[0] !== "number") continue;

    out.push({
      row_number: row[0] as number,
      time: excelDateTimeToIso(row[2]),
      username: strOf(row[3]),
      confirmation_number: strOf(row[4]),
      guest_name: strOf(row[5]),
      check_in_datetime: excelDateTimeToIso(row[6 + o]),
      check_out_datetime: excelDateTimeToIso(row[7 + o]),
      room_number: strOf(row[8 + o]),
      action: strOf(row[9 + o]),
      previous_value: strOf(row[10 + o]),
      current_value: strOf(row[11 + o]),
      remarks: strOf(row[12 + o]),
    });
  }

  return out.length ? out : null;
}

// ── SETTLEMENT BY PAYMENT TYPE (Excel) → settlements ─────────────────
// One row per payment settlement — the source of truth for CC reconciliation.
// Details section columns (0-based):
//   0:# 1:AccountCategory 2:Date 3:Time 4:TransactionNumber 5:FolioNumber
//   6:GuestName 7:AccountName 8:RoomNumber 9:PaymentType
//   10:PaymentDescription(card last-4) 11:Amount 12:Username 13:Remarks
// A trailing "Summary" sub-table (PaymentType | Amount | Count) is a pure
// rollup of the detail rows, so we skip it to avoid double-counting.

interface SettlementRow {
  row_number: number;
  account_category: string;
  date: string | null;
  time: string | null;
  transaction_number: string;
  folio_number: string;
  guest_name: string;
  account_name: string;
  room_number: string;
  payment_type: string;
  payment_detail: string;
  amount: number | null;
  username: string;
  remarks: string;
}

function parseSettlementsXlsx(rows: unknown[][]): SettlementRow[] | null {
  const out: SettlementRow[] = [];
  const seen = new Set<number>();
  let inDetail = false;
  // Mid-July 2026 layout change: "First Name"/"Last Name" inserted after Guest Name
  let o = 0;

  for (const row of rows) {
    const col1 = typeof row[1] === "string" ? row[1].trim() : "";
    if (col1 === "Account Category") {
      o = row.some((c) => typeof c === "string" && c.trim() === "First Name") ? 2 : 0;
      inDetail = true; continue;
    }
    if (col1 === "Summary") break;
    if (!inDetail) continue;
    if (typeof row[0] !== "number") continue; // skip subtotal/blank rows
    // Manual portal exports wrap long rows onto a continuation line that
    // repeats the row number but is otherwise empty — real rows always carry
    // the transaction date. Skip continuations and any duplicate row number.
    if (!excelDateToIso(row[2])) continue;
    if (seen.has(row[0] as number)) continue;
    seen.add(row[0] as number);

    out.push({
      row_number: row[0] as number,
      account_category: strOf(row[1]),
      date: excelDateToIso(row[2]),
      time: excelTimeToString(row[3]),
      transaction_number: strOf(row[4]),
      folio_number: strOf(row[5]),
      guest_name: strOf(row[6]),
      account_name: strOf(row[7 + o]),
      room_number: strOf(row[8 + o]),
      payment_type: strOf(row[9 + o]),
      payment_detail: strOf(row[10 + o]),
      amount: toNum(row[11 + o]),
      username: strOf(row[12 + o]),
      remarks: strOf(row[13 + o]),
    });
  }

  return out.length ? out : null;
}

// ── BUSINESS TRACK (Fiserv) → processor_transactions ─────────────────
// "Settlement / Search" export: one row per card transaction as the processor
// sees it. Invoice Number carries HotelKey's transaction number, so Loop 1
// reconciliation joins on it. Columns are located by header name (not fixed
// position) because the CSV and XLSX exports lay out the same ~80 columns and
// Fiserv may reorder them between report templates.

interface ProcessorTxRow {
  tran_uid: string;
  txn_date: string | null;
  batch_date: string | null;
  funded_date: string | null;
  batch_no: string;
  invoice_number: string;
  network: string;
  account_last4: string;
  amount: number | null;
  transaction_type: string;
  transaction_status: string;
  auth_code: string;
}

// Business Track dates arrive as "MM/DD/YYYY" strings (CSV and text-formatted
// XLSX cells) or as Date objects (typed XLSX cells) — handle both.
function usDateToIso(v: unknown): string | null {
  if (v instanceof Date) return excelDateToIso(v);
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function parseBusinessTrack(rows: unknown[][]): ProcessorTxRow[] | null {
  // Locate the data header row: contains both "Invoice Number" and "Txn Date".
  // (The "Request Details" preamble also lists field names in one row, but that
  // row starts with "Detail Fields" — skip any row whose first cell is that.)
  let headerIdx = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row[0] === "string" && row[0].trim() === "Detail Fields") continue;
    const names = row.map((c) => (typeof c === "string" ? c.trim() : ""));
    if (names.includes("Invoice Number") && names.includes("Txn Date")) {
      headerIdx = i;
      names.forEach((n, idx) => { if (n && cols[n] === undefined) cols[n] = idx; });
      break;
    }
  }
  if (headerIdx < 0) return null;

  const col = (name: string) => cols[name] ?? -1;
  const get = (row: unknown[], name: string) => { const i = col(name); return i >= 0 ? row[i] : undefined; };

  const out: ProcessorTxRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    // Data rows carry the numeric Site ID in the first mapped column; stop at
    // blank rows or a repeated header (multi-page exports repeat headers).
    const siteId = get(row, "Site ID (BE)");
    if (siteId == null || strOf(siteId) === "" || strOf(siteId) === "Site ID (BE)") continue;

    const batchNo = strOf(get(row, "Batch No."));
    const uid = strOf(get(row, "Tran UID")) || `${batchNo}-${i}`;
    out.push({
      tran_uid: uid,
      txn_date: usDateToIso(get(row, "Txn Date")),
      batch_date: usDateToIso(get(row, "Batch Date")),
      funded_date: usDateToIso(get(row, "Funded Date")),
      batch_no: batchNo,
      invoice_number: strOf(get(row, "Invoice Number")),
      network: strOf(get(row, "Network")),
      account_last4: strOf(get(row, "Account #(Last 4)")),
      amount: toNum(get(row, "Processed Sales Amount")),
      transaction_type: strOf(get(row, "Transaction Type")),
      transaction_status: strOf(get(row, "Transaction Status")),
      auth_code: strOf(get(row, "Auth Code")),
    });
  }
  return out.length ? out : null;
}

// ── Supabase REST helpers ─────────────────────────────────────────────

async function fetchOne(table: string, filter: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&limit=1`, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`DB fetch failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsert(table: string, row: Record<string, unknown>, conflict: string) {
  await upsertBatch(table, [row], conflict);
}

async function upsertBatch(table: string, rows: Record<string, unknown>[], conflict: string) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`DB upsert failed (${res.status}): ${await res.text()}`);
  }
}

// ── Request handler ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    let file: File | null = null;
    let property = "WKFCW";

    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      // Power Automate JSON path: { filename, content (base64), property }
      const body = await req.json() as { filename?: string; content?: string; property?: string };
      property = body.property || "WKFCW";
      if (body.filename && body.content) {
        const bytes = Uint8Array.from(atob(body.content), c => c.charCodeAt(0));
        file = new File([bytes], body.filename);
      }
    } else {
      const form = await req.formData();
      file = form.get("file") as File | null;
      property = String(form.get("property") || "WKFCW");
    }

    if (!file) {
      return Response.json({ success: false, error: "No file provided" }, { headers: CORS });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "pdf" && ext !== "xlsx" && ext !== "xls" && ext !== "csv") {
      return Response.json(
        { success: false, error: `File type .${ext} is not yet supported by this processor` },
        { headers: CORS },
      );
    }

    let bytes = new Uint8Array(await file.arrayBuffer());
    const isExcel = ext === "xlsx" || ext === "xls" || ext === "csv"; // SheetJS parses CSV via the same reader

    // Power Automate flows sometimes save attachment contentBytes without
    // decoding, leaving the file as one long base64 string. Detect and decode:
    // a real CSV contains commas in its first line; a base64 blob doesn't.
    if (ext === "csv") {
      const head = new TextDecoder().decode(bytes.subarray(0, 200));
      if (!head.includes(",") && /^[A-Za-z0-9+/=\r\n]+$/.test(head)) {
        try {
          const text = new TextDecoder().decode(bytes).replace(/\s/g, "");
          bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        } catch { /* not base64 after all — leave as-is */ }
      }
    }
    const xlsxRows = isExcel ? extractXlsxRows(bytes) : null;
    const text = isExcel ? xlsxRowsToText(xlsxRows!) : extractPdfText(bytes);
    const type = detectReportType(text);

    switch (type) {
      case "HOTEL_STATISTICS": {
        const parsed = isExcel ? parseHotelStatisticsXlsx(xlsxRows!) : parseHotelStatistics(text);
        if (!parsed) {
          return Response.json(
            { success: false, error: "HOTEL_STATISTICS detected but required fields could not be parsed", type },
            { headers: CORS },
          );
        }
        // Guard against out-of-order uploads: refuse to overwrite a monthly_revenue
        // M-T-D row with a snapshot that's older than what's already stored for the
        // same property+period. Each daily upload's M-T-D column only reflects totals
        // through that day, so an older snapshot would silently roll the running
        // total backwards (this happened for real on 2026-06-07 — June 3's M-T-D
        // overwrote June 4's, dropping room_revenue from $29,571.58 to $22,541.18).
        const existingMonthly = await fetchOne(
          "monthly_revenue",
          `property=eq.${encodeURIComponent(property)}&period_start=eq.${parsed.monthlyRow.period_start}&select=snapshot_date`,
        );
        const existingSnapshot = existingMonthly?.snapshot_date as string | null | undefined;
        const staleMonthly = !!existingSnapshot && existingSnapshot > parsed.date;

        let rows = 0;
        if (staleMonthly) {
          console.warn(
            `Skipping monthly_revenue upsert for ${property} ${parsed.monthlyRow.period_start}: ` +
            `incoming snapshot ${parsed.date} is older than stored snapshot ${existingSnapshot}`,
          );
        } else {
          await upsert("monthly_revenue", { ...parsed.monthlyRow, property }, "property,period_start");
          rows = 1;
        }

        if (parsed.dailyRow) {
          await upsert("daily_revenue", { ...parsed.dailyRow, property }, "property,date");
          rows += 1;
        }

        // Excel exports additionally give us clean per-line-item detail
        // (Misc Revenue / Taxes / Payments / Fee breakdowns) — store them too.
        const lineItems = (parsed as HotelStatsXlsxResult).lineItems;
        if (lineItems && lineItems.length) {
          await upsertBatch(
            "revenue_line_items",
            lineItems.map((li) => ({
              property,
              date: parsed.date,
              section: li.section,
              label: li.label,
              actual_today: li.vals[0],
              mtd: li.vals[1],
              ly_mtd: li.vals[2],
              ytd: li.vals[3],
              ly_ytd: li.vals[4],
            })),
            "property,date,section,label",
          );
          rows += lineItems.length;
        }

        return Response.json(
          {
            success: true,
            rows,
            type,
            granularity: parsed.granularity,
            date: parsed.date,
            ...(lineItems?.length ? { lineItems: lineItems.length } : {}),
            ...(staleMonthly
              ? { warning: `monthly_revenue not updated — a more recent snapshot (${existingSnapshot}) is already stored for this period` }
              : {}),
          },
          { headers: CORS },
        );
      }

      case "AR_AGING": {
        if (!isExcel) {
          return Response.json({ success: false, error: "AR_AGING (PDF) processing is not yet implemented — please upload the Excel export", type }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseDirectBillAgingXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "AR_AGING detected but could not be parsed (date or table not found)", type }, { headers: CORS });
        }
        await upsertBatch(
          "ar_aging",
          parsed.map((r) => ({
            property, date, category: r.category, company: r.company,
            current_bal: r.current_bal, over_7: r.over_7, over_14: r.over_14,
            over_30: r.over_30, over_60: r.over_60, over_90: r.over_90,
            over_120: r.over_120, over_150: r.over_150, total: r.total,
          })),
          "property,date,category,company",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "RATE_OVERRIDE": {
        if (!isExcel) {
          return Response.json({ success: false, error: "RATE_OVERRIDE (PDF) processing is not yet implemented — please upload the Excel export", type }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseRateOverrideXlsx(xlsxRows!);
        if (!date) {
          return Response.json({ success: false, error: "RATE_OVERRIDE: could not determine report date from filename", type }, { headers: CORS });
        }
        if (!parsed) {
          // No overrides that day is a normal, valid outcome — not an error.
          return Response.json({ success: true, rows: 0, type, date, note: "No rate overrides recorded for this date" }, { headers: CORS });
        }
        // Deduplicate by (stay_date, confirmation_no) — same reservation can appear
        // multiple times in the report if the rate was modified more than once.
        // Keep the last occurrence (most recent modification).
        const dedupMap = new Map<string, typeof parsed[0]>();
        for (const r of parsed) {
          dedupMap.set(`${r.stay_date}|${r.confirmation_no}`, r);
        }
        const deduped = Array.from(dedupMap.values());

        await upsertBatch(
          "rate_overrides",
          deduped.map((r) => ({
            property,
            stay_date: r.stay_date,
            modification_date: r.modification_date,
            confirmation_no: r.confirmation_no,
            guest_name: r.guest_name,
            check_in_date: r.check_in,
            check_out_date: r.check_out,
            room_number: r.room_number,
            room_type: r.room_type,
            sold_rate: r.sold_rate,
            new_rate: r.new_rate,
            override_amount: r.override_amount,
            rate_plan: r.rate_plan,
            market_segment: r.market_segment,
            username: r.username,
            override_reason: r.override_reason,
          })),
          "property,stay_date,confirmation_no",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "TAX_REPORT": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only report (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseTaxReportXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "TAX_REPORT detected but could not be parsed (date or summary table not found)", type }, { headers: CORS });
        }
        await upsertBatch(
          "tax_summary",
          parsed.map((r) => ({
            property, date, tax_name: r.tax_name,
            total_revenue: r.total_revenue, exempted_revenue: r.exempted_revenue,
            taxable_payable: r.taxable_payable, payable_tax: r.payable_tax, exempted_tax: r.exempted_tax,
          })),
          "property,date,tax_name",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "CLERK_ACTIVITY": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only report (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseClerkActivityXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "CLERK_ACTIVITY detected but could not be parsed (date or detail table not found)", type }, { headers: CORS });
        }
        await upsertBatch(
          "clerk_activity",
          parsed.map((r) => ({
            property, date,
            row_number: r.row_number,
            time: r.time,
            transaction_number: r.transaction_number,
            group_name: r.group_name,
            guest_name: r.guest_name,
            company: r.company,
            room_number: r.room_number,
            username: r.username,
            amount: r.amount,
            department_code: r.department_code,
            department_name: r.department_name,
            gl_account_code: r.gl_account_code,
            gl_account_name: r.gl_account_name,
            payment_type: r.payment_type,
            payment_detail: r.payment_detail,
          })),
          "property,date,row_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "DISPLAY_ONLY":
        return Response.json({ success: true, rows: 0, type, note: "Display-only report — not written to database" }, { headers: CORS });

      case "AR_ACTIVITY": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name);
        const parsed = parseArActivityXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "AR_ACTIVITY detected but could not be parsed", type }, { headers: CORS });
        }
        await upsertBatch(
          "ar_activity",
          parsed.map((r) => ({
            property, snapshot_date: date,
            row_number: r.row_number,
            transaction_date: r.transaction_date,
            company_name: r.company_name,
            company_code: r.company_code,
            transaction_type: r.transaction_type,
            transaction_number: r.transaction_number,
            guest_name: r.guest_name,
            check_in_date: r.check_in_date,
            check_out_date: r.check_out_date,
            current_bal: r.current_bal,
            over_30: r.over_30,
            over_60: r.over_60,
            over_90: r.over_90,
            over_120: r.over_120,
            over_150: r.over_150,
            amount: r.amount,
            transaction_status: r.transaction_status,
          })),
          "property,snapshot_date,row_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "ADJUSTMENTS": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseAdjustmentsXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "ADJUSTMENTS detected but could not be parsed", type }, { headers: CORS });
        }
        await upsertBatch(
          "adjustments_activity",
          parsed.map((r) => ({
            property, date,
            section: r.section,
            row_number: r.row_number,
            time: r.time,
            transaction_type: r.transaction_type,
            charge_type: r.charge_type,
            guest_name: r.guest_name,
            transaction_number: r.transaction_number,
            room_number: r.room_number,
            adjustment_reason: r.adjustment_reason,
            adjusted_amount: r.adjusted_amount,
            adjusted_tax: r.adjusted_tax,
            transferred_charge: r.transferred_charge,
            transferred_tax: r.transferred_tax,
            username: r.username,
            remarks: r.remarks,
          })),
          "property,date,section,row_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "USER_ACTIVITY": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name);
        const parsed = parseUserActivityXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "USER_ACTIVITY detected but could not be parsed", type }, { headers: CORS });
        }
        await upsertBatch(
          "user_activity",
          parsed.map((r) => ({
            property, date,
            row_number: r.row_number,
            time: r.time,
            username: r.username,
            confirmation_number: r.confirmation_number,
            guest_name: r.guest_name,
            check_in_datetime: r.check_in_datetime,
            check_out_datetime: r.check_out_datetime,
            room_number: r.room_number,
            action: r.action,
            previous_value: r.previous_value,
            current_value: r.current_value,
            remarks: r.remarks,
          })),
          "property,date,row_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "SETTLEMENTS": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only (PDF) — not written to database" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseSettlementsXlsx(xlsxRows!);
        if (!date) {
          return Response.json({ success: false, error: "SETTLEMENTS: could not determine report date", type }, { headers: CORS });
        }
        if (!parsed) {
          // No settlements that day is a normal, valid outcome
          return Response.json({ success: true, rows: 0, type, date, note: "No settlements recorded for this date" }, { headers: CORS });
        }
        await upsertBatch(
          "settlements",
          parsed.map((r) => ({
            property, date,
            row_number: r.row_number,
            account_category: r.account_category,
            time: r.time,
            transaction_number: r.transaction_number,
            folio_number: r.folio_number,
            guest_name: r.guest_name,
            account_name: r.account_name,
            room_number: r.room_number,
            payment_type: r.payment_type,
            payment_detail: r.payment_detail,
            amount: r.amount,
            username: r.username,
            remarks: r.remarks,
          })),
          "property,date,row_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      case "BUSINESS_TRACK": {
        if (!isExcel) {
          return Response.json({ success: false, error: "BUSINESS_TRACK is only supported as CSV/XLSX", type }, { headers: CORS });
        }
        const parsed = parseBusinessTrack(xlsxRows!);
        if (!parsed) {
          return Response.json({ success: false, error: "BUSINESS_TRACK detected but data table could not be parsed", type }, { headers: CORS });
        }
        await upsertBatch(
          "processor_transactions",
          parsed.map((r) => ({ property, ...r })),
          "property,tran_uid",
        );
        const batchDates = [...new Set(parsed.map((r) => r.batch_date).filter(Boolean))].sort();
        return Response.json({ success: true, rows: parsed.length, type, batch_dates: batchDates }, { headers: CORS });
      }

      case "OPERA_FLASH":
        return Response.json(
          { success: false, error: "OPERA_FLASH processing is not yet implemented in this build", type },
          { headers: CORS },
        );

      case "INHOUSE_BALANCES": {
        if (!isExcel) {
          return Response.json({ success: true, rows: 0, type, note: "Display-only (PDF)" }, { headers: CORS });
        }
        const date = dateFromFilename(file.name) ?? dateFromContentRows(xlsxRows!);
        const parsed = parseInhouseXlsx(xlsxRows!);
        if (!date || !parsed) {
          return Response.json({ success: false, error: "INHOUSE_BALANCES detected but could not be parsed", type }, { headers: CORS });
        }
        // Deduplicate by room_number — on turnover days a room appears twice
        // (CHECKED_OUT then CHECKED_IN). Keep the last occurrence; Hilton OnQ
        // lists departures before arrivals so the new occupant wins.
        const roomMap = new Map<string, typeof parsed[0]>();
        for (const r of parsed) { if (r.room_number) roomMap.set(r.room_number, r); }
        const deduped = Array.from(roomMap.values());

        await upsertBatch(
          "inhouse_balances",
          deduped.map((r) => ({
            property, date,
            room_number: r.room_number, guest_name: r.guest_name,
            company: r.company, arrival_date: r.arrival_date,
            departure_date: r.departure_date, room_rate: r.room_rate,
            folio_balance: r.folio_balance, payment_method: r.payment_method,
            credit_limit: r.credit_limit,
          })),
          "property,date,room_number",
        );
        return Response.json({ success: true, rows: parsed.length, type, date }, { headers: CORS });
      }

      default:
        return Response.json(
          { success: false, error: "Could not identify report type from PDF content", type: "UNKNOWN" },
          { headers: CORS },
        );
    }
  } catch (e) {
    console.error(e);
    return Response.json({ success: false, error: String(e) }, { headers: CORS });
  }
});
