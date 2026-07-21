const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return Response.json({ valid: false }, { headers: CORS });

  let body: { property?: string; pin?: string };
  try { body = await req.json(); } catch { return Response.json({ valid: false }, { headers: CORS }); }

  const { property, pin } = body;
  if (!property || !pin) return Response.json({ valid: false }, { headers: CORS });

  // PINs stored as Supabase secrets — never exposed to client
  const envKey = `PIN_${property.toUpperCase()}`;
  const expected = Deno.env.get(envKey);
  const valid = !!(expected && pin === expected);

  // Rate-limit signal: always take ~200ms to prevent brute-force timing attacks
  await new Promise(r => setTimeout(r, 200));

  return Response.json({ valid }, { headers: CORS });
});
