// Supabase Edge Function (Deno): fraga-dagboken
//
// Hon ställer en fråga om sin egen dagbok i appen ("Fråga din dagbok"). Funktionen
// läser hennes dagbok för det senaste året, skickar den tillsammans med samtalet
// till Claude och returnerar svaret.
//
// POST { today: "YYYY-MM-DD", messages: [{ role, content }] }
//   -> 200 { reply, crisis }
//   -> fel { error, message } med status 400/401/403/405/500/502
//
// Demoläge: POST { today, messages, demo: true, rows: [{ store, key, data, deleted_at }] }.
// Då skickar appen (utvecklarens demoläge) sin PÅHITTADE demodagbok i anropet. Servern
// använder BARA de skickade raderna (validateDemoRows), hoppar över partnerkollen (partner-
// konton får prova) och läser aldrig databasen. Inloggning krävs fortfarande. Riktig data
// är aldrig inblandad. Raderna loggas aldrig.
//
// Säkerhet: anropas med hennes egen access token (JWT-verifiering på). Läsningen
// sker med HENNES token under RLS, aldrig med service role-nyckeln. Partnerkonton
// (viewer, aldrig owner) nekas. Logga aldrig frågor, svar, dagbok eller anteckningar.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { type RecordRow, shiftDay, stockholmNow } from "../daglig-koll/logic.ts";
import {
  buildDiary,
  buildParams,
  CRISIS_NOTE,
  DIARY_DAYS,
  detectCrisis,
  finalizeReply,
  REFUSAL_REPLY,
  validateChat,
  validateDemoRows,
} from "./logic.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Svar med CORS-headers (även för fel, annars ser appen bara ett nätverksfel). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

const ROW_COLS = "store,key,data,deleted_at";
const PAGE = 1000;

/** Hämtar alla sidor (1000 rader per anrop) för en fråga. */
async function fetchAll(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<RecordRow[]> {
  const out: RecordRow[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error("records: " + error.message);
    const rows = (data ?? []) as RecordRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Hennes rader: omgångar, mående, blödningar, snabbval, kartstarter och uppehåll.
 * Varje fråga har user_id = hennes id: viewer-policyn skulle annars också ge
 * ägarens rader.
 */
async function loadRows(db: SupabaseClient, userId: string, today: string): Promise<RecordRow[]> {
  const from = shiftDay(today, -(DIARY_DAYS - 1));
  const base = () => db.from("records").select(ROW_COLS).eq("user_id", userId);
  const parts = await Promise.all([
    fetchAll((a, b) => base().eq("store", "courses").order("key", { ascending: true }).range(a, b)),
    fetchAll((a, b) => base().eq("store", "notes").eq("key", "tags").range(a, b)),
    fetchAll((a, b) =>
      base().eq("store", "mood").gte("key", from).lte("key", today).order("key", { ascending: true }).range(a, b)
    ),
    // Blödningar: servernyckeln är ett uid, så filtrera på datumet i data.
    fetchAll((a, b) =>
      base().eq("store", "bleeding").gte("data->>date", from).lte("data->>date", today)
        .order("key", { ascending: true }).range(a, b)
    ),
    fetchAll((a, b) =>
      base().eq("store", "notes").gte("key", "ppiller:" + from).lte("key", "ppiller:" + today)
        .order("key", { ascending: true }).range(a, b)
    ),
    // Alla uppehåll (ett kan ha startat före fönstret); filtreras i buildAiInput.
    fetchAll((a, b) => base().eq("store", "notes").like("key", "ppaus:%").order("key", { ascending: true }).range(a, b)),
  ]);
  return parts.flat();
}

/** Reservväg för anon-nyckeln: första nyckeln i SUPABASE_PUBLISHABLE_KEYS (JSON, objekt eller lista). */
function firstPublishableKey(): string | undefined {
  try {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    const vals: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
    const k = vals.find((v) => typeof v === "string" && v.length > 0);
    return typeof k === "string" ? k : undefined;
  } catch (_) {
    return undefined;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST") return fail(405, "method", "Använd POST.");

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || firstPublishableKey();
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!url || !anonKey || !apiKey) {
    console.error("Saknade hemligheter (SUPABASE_URL, SUPABASE_ANON_KEY eller ANTHROPIC_API_KEY)");
    return fail(500, "not_configured", "Funktionen är inte färdigkonfigurerad ännu.");
  }

  // --- Inloggning -------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(401, "unauthorized", "Du behöver vara inloggad.");

  // Klient med hennes egen token (RLS gäller), aldrig service role.
  const db = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uErr } = await db.auth.getUser(token);
  if (uErr || !u?.user) return fail(401, "unauthorized", "Du behöver vara inloggad.");
  const user = u.user;

  // --- Indata -----------------------------------------------------------------
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch (_) {
    return fail(400, "bad_request", "Frågan kunde inte läsas.");
  }
  const chat = validateChat(body, stockholmNow().day);
  if (!chat.ok) return fail(400, "bad_request", chat.message);

  // Kris upptäcks bara i hennes SENASTE meddelande. Beräknas direkt så att kristexten
  // kan returneras även om något längre fram misslyckas.
  const crisis = detectCrisis(chat.messages[chat.messages.length - 1].content);
  const crisisFallback = () => json({ reply: CRISIS_NOTE, crisis: true });

  // Demoläge: klienten skickar påhittade rader; databasen läses aldrig.
  const demo = (body as { demo?: unknown } | null)?.demo === true;
  let diary: string;
  if (demo) {
    const dr = validateDemoRows((body as { rows?: unknown }).rows);
    if (!dr.ok) return fail(400, "bad_request", dr.message);
    diary = buildDiary(dr.rows, chat.today);
  } else {
    // --- Partnerkoll: viewer som aldrig är owner får inte använda funktionen ------
    try {
      const [asViewer, asOwner] = await Promise.all([
        db.from("shares").select("owner").eq("viewer", user.id).limit(1),
        db.from("shares").select("viewer").eq("owner", user.id).limit(1),
      ]);
      if (asViewer.error) throw new Error("shares: " + asViewer.error.message);
      if (asOwner.error) throw new Error("shares: " + asOwner.error.message);
      if ((asViewer.data ?? []).length > 0 && (asOwner.data ?? []).length === 0) {
        return fail(403, "partner", "Det här finns bara i hennes egen app.");
      }
    } catch (e) {
      console.error((e as Error).message); // bara felmeddelandet
      if (crisis) return crisisFallback();
      return fail(500, "not_configured", "Något gick fel när dagboken skulle läsas. Försök igen strax.");
    }

    // --- Dagboken ---------------------------------------------------------------
    try {
      diary = buildDiary(await loadRows(db, user.id, chat.today), chat.today);
    } catch (e) {
      console.error((e as Error).message);
      if (crisis) return crisisFallback();
      return fail(500, "not_configured", "Något gick fel när dagboken skulle läsas. Försök igen strax.");
    }
  }

  // --- Claude -----------------------------------------------------------------
  try {
    // Edge Functions avbryts efter ca 150 s, så anropet får ta högst 110 s
    // (och ett nytt försök) innan vi svarar själva.
    const client = new Anthropic({ apiKey, timeout: 110_000, maxRetries: 1 });
    // SDK:ts typer känner (ännu) inte till top-level cache_control, `fallbacks`
    // och role "system" mitt i samtalet, så objektet castas smalt här. Fälten
    // skickas som de är och avgörs av API:t.
    const params = buildParams(diary, chat.messages, crisis) as unknown as Parameters<
      typeof client.beta.messages.create
    >[0];
    const res = await client.beta.messages.create(params);
    // Hängande overload: vi anropar utan stream, så svaret är ett färdigt meddelande.
    const msg = res as unknown as { stop_reason: string | null; content: Array<{ type: string; text?: string }> };
    // Vägran: finalizeReply ger kristext vid kris, annars reservsvaret.
    if (msg.stop_reason === "refusal") return json({ reply: finalizeReply(crisis ? "" : REFUSAL_REPLY, crisis), crisis });
    // Bara textblock (inga tankeblock) går vidare.
    const text = msg.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("");
    return json({ reply: finalizeReply(text, crisis), crisis });
  } catch (e) {
    // Bara felmeddelandet, aldrig frågor eller dagbok.
    console.error("anthropic: " + (e as Error).message);
    if (crisis) return crisisFallback();
    // Timeout och övriga API-fel ger 502 med ett vänligt meddelande.
    // SDK:ns egen feltyp för timeout (en underklass till APIConnectionError).
    const timedOut = e instanceof Anthropic.APIConnectionTimeoutError;
    return fail(
      502,
      "upstream",
      timedOut
        ? "Svaret tog för lång tid. Försök igen, gärna med en kortare fråga."
        : "Jag kom inte åt AI-tjänsten just nu. Försök igen om en stund.",
    );
  }
});
