import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const allowedOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

function response(body: Record<string, unknown>, status: number, origin: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": origin && allowedOrigins.includes(origin) ? origin : "null",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
      },
    });
  }

  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405, origin);
  if (!origin || !allowedOrigins.includes(origin)) return response({ error: "Origin not allowed." }, 403, origin);

  try {
    const authorization = req.headers.get("authorization") || "";
    const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) return response({ error: "Authentication required." }, 401, origin);

    // Validate the caller's token with Supabase Auth; never trust a role sent by the browser.
    const { data: userData, error: userError } = await adminClient.auth.getUser(tokenMatch[1]);
    if (userError || !userData?.user) {
      return response({ error: "Invalid or expired session." }, 401, origin);
    }

    if (userData.user.app_metadata?.role !== "admin") {
      return response({ error: "Administrator access only." }, 403, origin);
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [
      failedResult,
      successResult,
      lockedResult,
      blockedResult,
      eventsResult,
    ] = await Promise.all([
      adminClient.from("security_events").select("id", { count: "exact", head: true })
        .eq("event_type", "login_failed").gte("created_at", since),
      adminClient.from("security_events").select("id", { count: "exact", head: true })
        .eq("event_type", "login_success").gte("created_at", since),
      adminClient.from("security_events").select("id", { count: "exact", head: true })
        .eq("event_type", "login_failed").eq("metadata->>account_locked", "true").gte("created_at", since),
      adminClient.from("security_events").select("id", { count: "exact", head: true })
        .eq("event_type", "ip_blocked").gte("created_at", since),
      adminClient.from("security_events")
        .select("id, attempted_email, event_type, ip_address, isp, country, region, city, browser, operating_system, created_at, metadata")
        .order("created_at", { ascending: false }).limit(100),
    ]);

    const queryError = failedResult.error || successResult.error ||
      lockedResult.error || blockedResult.error || eventsResult.error;
    if (queryError) {
      console.error("Admin dashboard query failed:", queryError);
      return response({ error: "Unable to load security monitoring data." }, 500, origin);
    }

    return response({
      success: true,
      administrator: userData.user.email,
      summary: {
        failed_logins: failedResult.count ?? 0,
        successful_logins: successResult.count ?? 0,
        locked_attempts: lockedResult.count ?? 0,
        ip_blocked: blockedResult.count ?? 0,
      },
      events: eventsResult.data ?? [],
      generated_at: new Date().toISOString(),
    }, 200, origin);
  } catch (error) {
    console.error("Admin security dashboard error:", error);
    return response({ error: "Unexpected server error." }, 500, origin);
  }
});
