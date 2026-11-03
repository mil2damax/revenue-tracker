// process-str — ingest STR (Smith Travel Research) Monthly STAR reports.
//
// Parses the "Glance" tab of a Monthly STAR workbook into tidy rows
// (one per metric × period) and upserts them into public.str_monthly.
// Accepts the same request shapes as process-night-audit: multipart form
// (file + property) or JSON { filename, content(base64), property }.
//
// The parser is label-driven: it locates the metric columns (Occupancy /
// ADR / RevPAR) and period rows (Current Month / Year To Date / Running 3 /
// Running 12) by their text, so it tolerates STR layout shifts.

import * as XLSX from "npm:xlsx@0.18.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// STR property id -> our internal hotel_code
const STR_ID_TO_HOTEL: Record<string, string> = { "75702": "RDURM" };

type Cell = unknown;
type Row = Cell[];

function norm(s: Cell): string {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}
function toNum(s: Cell): number | null {
  const t = norm(s).replace(/[%,$]/g, "").trim();
  if (t === "" || t === "-" || /^n\/?a$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const PERIODS: { key: string; re: RegExp }[] = [
  { key: "current", re: /^current month$/i },
  { key: "ytd", re: /^year to date$/i },
  { key: "run3", re: /^running 3 month$/i },
  { key: "run12", re: /^running 12 month$/i },
];
const METRICS = ["occ", "adr", "revpar"] as const;
type Metric = typeof METRICS[number];

interface StrRecord {
  hotel_code: string | null;
  report_month: string;
  str_id: string | null;
  date_created: string | null;
  metric: Metric;
  period: string;
  my_value: number | null;
  comp_value: number | null;
  idx: number | null;
  my_chg: number | null;
  comp_chg: number | null;
  idx_chg: number | null;
}

function parseGlance(rows: Row[]): { report_month: string; str_id: string | null; recs: StrRecord[] } {
  // --- metadata from the first few rows ---
  const flat = rows.slice(0, 6).flat().map(norm).join("  ");
  const mMonth = flat.match(/For the Month of:\s*([A-Za-z]+)\s+(\d{4})/i);
  const mId = flat.match(/STR ID:\s*(\d+)/i) || flat.match(/STR #\s*(\d+)/i);
  const mCreated = flat.match(/Date Created:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!mMonth) throw new Error('could not find "For the Month of" — not a Monthly STAR Glance tab');
  const report_month = `${mMonth[2]}-${String(MONTHS[mMonth[1].toLowerCase()]).padStart(2, "0")}-01`;
  const str_id = mId ? mId[1] : null;
  const date_created = mCreated
    ? `${mCreated[3]}-${String(MONTHS[mCreated[1].toLowerCase()]).padStart(2, "0")}-${String(mCreated[2]).padStart(2, "0")}`
    : null;
  const hotel_code = str_id && STR_ID_TO_HOTEL[str_id] ? STR_ID_TO_HOTEL[str_id] : null;

  // --- locate the metric header row (Occupancy / ADR / RevPAR) ---
  let metricRow = -1;
  let mCols: Record<Metric, number> | null = null;
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map(norm);
    const occ = cells.findIndex((c) => /^occupancy/i.test(c));
    const adr = cells.findIndex((c) => /^adr$/i.test(c));
    const rev = cells.findIndex((c) => /^revpar$/i.test(c));
    if (occ >= 0 && adr >= 0 && rev >= 0) { metricRow = r; mCols = { occ, adr, revpar: rev }; break; }
  }
  if (metricRow < 0 || !mCols) throw new Error("no metric header row (Occupancy/ADR/RevPAR)");

  // --- sub-header row with My Prop / Comp Set / Index ---
  let subRow = -1;
  for (let r = metricRow + 1; r < Math.min(metricRow + 4, rows.length); r++) {
    if (rows[r].map(norm).some((c) => /my prop/i.test(c))) { subRow = r; break; }
  }
  if (subRow < 0) throw new Error("no My Prop sub-header row");
  const sub = rows[subRow].map(norm);

  // Map each metric to its my/comp/idx columns, bounded by the next metric header.
  const order: [Metric, number][] = ([["occ", mCols.occ], ["adr", mCols.adr], ["revpar", mCols.revpar]] as [Metric, number][])
    .sort((a, b) => a[1] - b[1]);
  const colmap: Record<Metric, { my: number; comp: number; idx: number }> = {} as never;
  for (let i = 0; i < order.length; i++) {
    const [metric, start] = order[i];
    const end = i + 1 < order.length ? order[i + 1][1] : sub.length;
    colmap[metric] = {
      my: sub.findIndex((c, ci) => ci >= start && ci < end && /my prop/i.test(c)),
      comp: sub.findIndex((c, ci) => ci >= start && ci < end && /comp set/i.test(c)),
      idx: sub.findIndex((c, ci) => ci >= start && ci < end && /index/i.test(c)),
    };
  }

  // --- split value block from %change block via the "Percent Change" banner ---
  let pctRow = rows.length;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].map(norm).some((c) => /percent change/i.test(c))) { pctRow = r; break; }
  }

  const readBlock = (lo: number, hi: number) => {
    const out: Record<string, Record<Metric, { my: number | null; comp: number | null; idx: number | null }>> = {};
    for (let r = lo; r < hi; r++) {
      const cells = rows[r].map(norm);
      const label = cells.find((c) => PERIODS.some((p) => p.re.test(c)));
      if (!label) continue;
      const pkey = PERIODS.find((p) => p.re.test(label))!.key;
      out[pkey] = {} as never;
      for (const metric of METRICS) {
        const cm = colmap[metric];
        out[pkey][metric] = {
          my: cm.my >= 0 ? toNum(rows[r][cm.my]) : null,
          comp: cm.comp >= 0 ? toNum(rows[r][cm.comp]) : null,
          idx: cm.idx >= 0 ? toNum(rows[r][cm.idx]) : null,
        };
      }
    }
    return out;
  };
  const values = readBlock(subRow + 1, pctRow);
  const changes = readBlock(pctRow + 1, rows.length);

  const recs: StrRecord[] = [];
  for (const metric of METRICS) {
    for (const p of PERIODS) {
      const v = values[p.key]?.[metric];
      if (!v) continue;
      const c = changes[p.key]?.[metric];
      recs.push({
        hotel_code, report_month, str_id, date_created,
        metric, period: p.key,
        my_value: v.my, comp_value: v.comp, idx: v.idx,
        my_chg: c ? c.my : null, comp_chg: c ? c.comp : null, idx_chg: c ? c.idx : null,
      });
    }
  }
  return { report_month, str_id, recs };
}

// Parse the "Response Report" tab into competitive-set member rows.
// Returns [] if the tab or the property table can't be found.
function parseResponse(rows: Row[], report_month: string, hotel_code: string | null, str_id: string | null): Record<string, unknown>[] {
  // Find the property table header: a row with STR# and Name labels.
  let hdr = -1;
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map(norm);
    if (cells.some((c) => /^str\s*#?$/i.test(c)) && cells.some((c) => /^name$/i.test(c))) { hdr = r; break; }
  }
  if (hdr < 0) return [];
  const h = rows[hdr].map(norm);
  const col = (re: RegExp) => h.findIndex((c) => re.test(c));
  const cId = col(/^str\s*#?$/i), cName = col(/^name$/i), cCity = col(/city/i), cRooms = col(/^rooms$/i), cOpen = col(/open date/i);
  if (cId < 0 || cName < 0) return [];

  const out: Record<string, unknown>[] = [];
  for (let r = hdr + 1; r < rows.length; r++) {
    const id = norm(rows[r][cId]);
    if (!/^\d+$/.test(id)) break;             // stop at the first non-property row (blank / totals)
    out.push({
      hotel_code, report_month,
      member_str_id: id,
      member_name: cName >= 0 ? norm(rows[r][cName]) || null : null,
      city_state: cCity >= 0 ? norm(rows[r][cCity]) || null : null,
      rooms: cRooms >= 0 ? toNum(rows[r][cRooms]) : null,
      open_date: cOpen >= 0 ? (norm(rows[r][cOpen]) || null) : null,
      is_subject: str_id != null && id === str_id,
      str_id,
    });
  }
  return out;
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
  if (!res.ok) throw new Error(`DB upsert failed (${res.status}): ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    let file: File | null = null;
    let property = "RDURM";

    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await req.json() as { filename?: string; content?: string; property?: string };
      property = body.property || "RDURM";
      if (body.filename && body.content) {
        const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
        file = new File([bytes], body.filename);
      }
    } else {
      const form = await req.formData();
      file = form.get("file") as File | null;
      property = String(form.get("property") || "RDURM");
    }

    if (!file) return Response.json({ success: false, error: "No file provided" }, { headers: CORS });
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx" && ext !== "xls") {
      return Response.json({ success: false, error: `STR reports must be .xlsx (got .${ext})` }, { headers: CORS });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const wb = XLSX.read(bytes, { type: "array" });
    const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "glance");
    if (!sheetName) {
      return Response.json({ success: false, error: 'No "Glance" sheet — is this a Monthly STAR report?' }, { headers: CORS });
    }
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" }) as Row[];

    const { report_month, str_id, recs } = parseGlance(rows);

    // Prefer the STR-id mapping; fall back to the posted property param.
    const hotel = recs[0]?.hotel_code || property;
    const out = recs.map((r) => ({ ...r, hotel_code: r.hotel_code || hotel }));
    if (!out.length) {
      return Response.json({ success: false, error: "Glance tab parsed but no metric rows found", report_month }, { headers: CORS });
    }

    await upsertBatch("str_monthly", out, "hotel_code,report_month,metric,period");

    // Competitive-set membership from the Response Report tab (best-effort —
    // never let this fail the main metric ingest, e.g. if str_compset is absent).
    let compsetRows = 0;
    try {
      const respName = wb.SheetNames.find((n) => n.toLowerCase() === "response");
      if (respName) {
        const respRows = XLSX.utils.sheet_to_json(wb.Sheets[respName], { header: 1, raw: false, defval: "" }) as Row[];
        const members = parseResponse(respRows, report_month, hotel, str_id).map((m) => ({ ...m, hotel_code: m.hotel_code || hotel }));
        if (members.length) {
          await upsertBatch("str_compset", members, "hotel_code,report_month,member_str_id");
          compsetRows = members.length;
        }
      }
    } catch (e) {
      console.warn("str_compset upsert skipped:", String(e));
    }

    return Response.json({ success: true, rows: out.length, compsetRows, report_month, str_id, hotel }, { headers: CORS });
  } catch (e) {
    return Response.json({ success: false, error: String(e) }, { headers: CORS });
  }
});
