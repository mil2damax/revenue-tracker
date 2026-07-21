/**
 * sync-sharepoint — Daily automated ingest from SharePoint
 *
 * Scheduled to run at 7am ET (11:00 UTC) every day.
 * Reads today's night audit folder in SharePoint, downloads all 9 xlsx files,
 * and ingests each one through the existing process-night-audit parser.
 *
 * Idempotent: if today's data is already in daily_revenue, skips cleanly.
 * Safe to run multiple times — parser uses upsert throughout.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

// ---------------------------------------------------------------------------
// Config from Supabase Secrets
// ---------------------------------------------------------------------------
const TENANT_ID     = Deno.env.get('SHAREPOINT_TENANT_ID')!;
const CLIENT_ID     = Deno.env.get('SHAREPOINT_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('SHAREPOINT_CLIENT_SECRET')!;
const SITE_URL      = Deno.env.get('SHAREPOINT_SITE_URL')!; // e.g. https://milkamhospitality.sharepoint.com/sites/MilkamCentral
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ---------------------------------------------------------------------------
// Date helpers — always use Eastern Time so date matches HotelKey audit date
// ---------------------------------------------------------------------------
function todayET(): { mm: string; dd: string; yy: string; yyyy: string; monthName: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  const mm = get('month'), dd = get('day'), yyyy = get('year'), yy = yyyy.slice(2);
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const monthName = monthNames[parseInt(mm, 10) - 1];
  return { mm, dd, yy, yyyy, monthName };
}

function dateStamp(): string {
  const { mm, dd, yy } = todayET();
  return `${mm}.${dd}.${yy}`; // 06.10.26
}

function folderPath(): string {
  const { mm, dd, yy, yyyy, monthName } = todayET();
  const ds = `${mm}.${dd}.${yy}`;
  const mf = `${mm} ${monthName}`;
  return `Mgmt/Meeneh/03 Front Office/01 WKFCW Night Audit/${yyyy}/${mf}/${ds}`;
}

// ---------------------------------------------------------------------------
// Microsoft Graph helpers
// ---------------------------------------------------------------------------
async function getToken(): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getSiteId(token: string): Promise<string> {
  // Strip protocol and split hostname from path
  const url = new URL(SITE_URL);
  const hostname = url.hostname; // milkamhospitality.sharepoint.com
  const sitePath = url.pathname; // /sites/MilkamCentral
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (!data.id) throw new Error(`SharePoint site not found: ${JSON.stringify(data)}`);
  return data.id;
}

async function listXlsxFiles(token: string, siteId: string, path: string): Promise<any[]> {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeURIComponent(path)}:/children`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (resp.status === 404) return []; // folder not created yet
  const data = await resp.json();
  if (!data.value) throw new Error(`List error: ${JSON.stringify(data)}`);
  return data.value.filter((f: any) => f.name?.endsWith('.xlsx'));
}

async function downloadFile(token: string, item: any): Promise<ArrayBuffer> {
  // Graph provides a pre-signed downloadUrl that doesn't need the token
  const url = item['@microsoft.graph.downloadUrl'];
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed ${resp.status}: ${item.name}`);
  return resp.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Check if today has already been synced (idempotency guard)
// ---------------------------------------------------------------------------
async function alreadySynced(date: string): Promise<boolean> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_revenue?property=eq.WKFCW&date=eq.${date}&select=date&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0;
}

// ---------------------------------------------------------------------------
// Process one file through the existing parser
// ---------------------------------------------------------------------------
async function processFile(filename: string, content: ArrayBuffer): Promise<any> {
  const form = new FormData();
  form.append('file', new Blob([content], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), filename);
  form.append('property', 'WKFCW');

  const resp = await fetch(
    `${SUPABASE_URL}/functions/v1/process-night-audit`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: form,
    }
  );
  return resp.json();
}

// ---------------------------------------------------------------------------
// Write sync result to sync_log table
// ---------------------------------------------------------------------------
async function writeSyncLog(entry: object): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(entry),
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const startedAt = new Date().toISOString();
  const ds = dateStamp();     // 06.10.26
  const fp = folderPath();    // Mgmt/Meeneh/.../06.10.26

  // Derive ISO date from stamp for DB queries (2026-06-10)
  const { mm, dd, yyyy } = todayET();
  const isoDate = `${yyyy}-${mm}-${dd}`;

  try {
    // Idempotency: skip if Hotel Statistics already ingested today
    const synced = await alreadySynced(isoDate);
    if (synced) {
      return Response.json({
        success: true,
        skipped: true,
        message: `Already synced for ${isoDate} — no action taken`,
      }, { headers: CORS });
    }

    // Authenticate + locate SharePoint folder
    const token   = await getToken();
    const siteId  = await getSiteId(token);
    const files   = await listXlsxFiles(token, siteId, fp);

    if (files.length === 0) {
      await writeSyncLog({
        ran_at: startedAt, property: 'WKFCW', date: isoDate,
        files_found: 0, files_processed: 0, skipped: false,
        status: 'NO_FILES',
        message: `SharePoint folder empty or not yet created: ${fp}`,
        results: [],
      });
      return Response.json({
        success: false,
        message: `No files found in ${fp} — Power Automate may still be running`,
        folderPath: fp,
      }, { headers: CORS });
    }

    // Process each file
    const results: any[] = [];
    for (const file of files) {
      try {
        const content = await downloadFile(token, file);
        const result  = await processFile(file.name, content);
        results.push({ file: file.name, success: result.success, type: result.type, rows: result.rows, error: result.error });
      } catch (e) {
        results.push({ file: file.name, success: false, error: String(e) });
      }
    }

    const processed = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success).length;

    await writeSyncLog({
      ran_at: startedAt, property: 'WKFCW', date: isoDate,
      files_found: files.length, files_processed: processed,
      skipped: false, status: failed === 0 ? 'OK' : 'PARTIAL',
      results,
    });

    return Response.json({
      success: true,
      date: isoDate,
      folderPath: fp,
      filesFound: files.length,
      processed,
      failed,
      results,
    }, { headers: CORS });

  } catch (e) {
    await writeSyncLog({
      ran_at: startedAt, property: 'WKFCW', date: isoDate,
      files_found: 0, files_processed: 0, skipped: false,
      status: 'ERROR', message: String(e), results: [],
    }).catch(() => {});

    return Response.json({ success: false, error: String(e) }, { headers: CORS, status: 500 });
  }
});
