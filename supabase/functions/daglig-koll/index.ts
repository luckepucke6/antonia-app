// Supabase Edge Function (Deno): daglig-koll
//
// Körs varje timme av pg_cron (se supabase/notiser.sql, avsnitt d). Gör, i
// svensk tid och högst en gång per användare, sort och dag:
//   med   – påminnelse om tablett (08–11, aktiv omgång, ingen dos loggad idag)
//   logg  – påminnelse om dagens check-in (20–22, inget mående loggat idag)
//   ai    – "är det dags igen?"-koll med Claude (21–23), sparar raden
//           notes/signal och skickar ev. notis till henne och till partnern
//
// POST {}              – dagligt jobb (cron)
// POST {"test": true}  – skicka en testnotis till alla prenumerationer
// POST {"dry": true}   – kör logiken för alla, utan tidsgrind och notify_log,
//                        anropar Claude men skickar/skriver INGET
//
// Hemlighet: headern x-cron-secret måste vara lika med CRON_SECRET.
// Logga aldrig anteckningstext eller andra hälsouppgifter.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
// @deno-types="npm:@types/web-push@3.6.4"
import webpush from "npm:web-push@3.6.7";
import {
  aiSkipReason,
  buildAiInput,
  hourEligible,
  type Kind,
  needsLogReminder,
  needsMedReminder,
  NO_SIGNAL,
  parseSignalText,
  type RecordRow,
  type Signal,
  shiftDay,
  stockholmNow,
} from "./logic.ts";

const MODEL = "claude-sonnet-5-5";
const AI_DAYS = 150;
const PUSH_TTL_SECONDS = 6 * 60 * 60; // en påminnelse är värdelös efter några timmar
const SIGNAL_COOLDOWN_DAYS = 4;

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "CRON_SECRET",
] as const;

type Env = Record<(typeof REQUIRED_ENV)[number], string>;

function loadEnv(): Env {
  const missing = REQUIRED_ENV.filter((k) => !Deno.env.get(k));
  if (missing.length) throw new Error("Saknade hemligheter: " + missing.join(", "));
  return Object.fromEntries(REQUIRED_ENV.map((k) => [k, Deno.env.get(k)!])) as Env;
}

interface Payload {
  title: string;
  body: string;
  view: string;
}

interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------
// web-push används bara för att KRYPTERA och signera (generateRequestDetails);
// själva POST:en görs med fetch så att vi inte hänger på Node:s https-modul.

async function pushToSub(sub: Sub, payload: Payload): Promise<"sent" | "gone" | "failed"> {
  try {
    const d = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: PUSH_TTL_SECONDS, urgency: "normal" },
    );
    const res = await fetch(d.endpoint, {
      method: d.method,
      headers: d.headers as Record<string, string>,
      body: new Uint8Array(d.body as Buffer),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch (_) {
    return "failed";
  }
}

interface PushCounts {
  subs: number;
  sent: number;
  removed: number;
  failed: number;
}

async function pushToSubs(db: SupabaseClient, subs: Sub[], payload: Payload): Promise<PushCounts> {
  const c: PushCounts = { subs: subs.length, sent: 0, removed: 0, failed: 0 };
  for (const s of subs) {
    const r = await pushToSub(s, payload);
    if (r === "sent") c.sent++;
    else if (r === "failed") c.failed++;
    else {
      c.removed++;
      await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    }
  }
  return c;
}

async function subsOf(db: SupabaseClient, userId: string): Promise<Sub[]> {
  const { data, error } = await db
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("user_id", userId);
  if (error) throw new Error("push_subscriptions: " + error.message);
  return (data ?? []) as Sub[];
}

// ---------------------------------------------------------------------------
// notify_log
// ---------------------------------------------------------------------------

/** true = vi tog platsen (första gången idag), false = redan gjort. */
async function claim(db: SupabaseClient, userId: string, kind: Kind, day: string): Promise<boolean> {
  const { error } = await db.from("notify_log").insert({ user_id: userId, kind, day });
  if (!error) return true;
  if (error.code === "23505") return false; // primärnyckeln: redan loggat
  throw new Error("notify_log: " + error.message);
}

async function release(db: SupabaseClient, userId: string, kind: Kind, day: string) {
  await db.from("notify_log").delete().eq("user_id", userId).eq("kind", kind).eq("day", day);
}

async function recentSignalLogged(db: SupabaseClient, userId: string, today: string): Promise<boolean> {
  const { data, error } = await db
    .from("notify_log")
    .select("day")
    .eq("user_id", userId)
    .eq("kind", "signal")
    .gte("day", shiftDay(today, -SIGNAL_COOLDOWN_DAYS))
    .lt("day", today)
    .limit(1);
  if (error) throw new Error("notify_log: " + error.message);
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Distinkta user_id i records, via nyckelpaginering (ett litet anrop per ägare). */
async function listOwners(db: SupabaseClient): Promise<string[]> {
  const owners: string[] = [];
  let last: string | null = null;
  for (;;) {
    let q = db.from("records").select("user_id").order("user_id", { ascending: true }).limit(1);
    if (last) q = q.gt("user_id", last);
    const { data, error } = await q;
    if (error) throw new Error("records: " + error.message);
    if (!data || data.length === 0) break;
    last = data[0].user_id as string;
    owners.push(last);
  }
  return owners;
}

const ROW_COLS = "store,key,data,deleted_at";

/** Allt en ägares logik behöver: omgångar, dagens dos, och mående senaste dagarna. */
async function loadRows(db: SupabaseClient, userId: string, today: string): Promise<RecordRow[]> {
  const from = shiftDay(today, -(AI_DAYS - 1));
  const [courses, meds, moods] = await Promise.all([
    db.from("records").select(ROW_COLS).eq("user_id", userId).eq("store", "courses"),
    db.from("records").select(ROW_COLS).eq("user_id", userId).eq("store", "medication")
      .eq("data->>date", today),
    db.from("records").select(ROW_COLS).eq("user_id", userId).eq("store", "mood")
      .gte("key", from).lte("key", today).order("key", { ascending: true }).limit(1000),
  ]);
  for (const r of [courses, meds, moods]) if (r.error) throw new Error("records: " + r.error.message);
  return [...(courses.data ?? []), ...(meds.data ?? []), ...(moods.data ?? [])] as RecordRow[];
}

async function viewersOf(db: SupabaseClient, owner: string): Promise<string[]> {
  const { data, error } = await db.from("shares").select("viewer").eq("owner", owner);
  if (error) throw new Error("shares: " + error.message);
  return (data ?? []).map((r) => r.viewer as string);
}

/**
 * Konton som bara är partner (viewer i shares, aldrig owner). De kan ha egna
 * rader i records, t.ex. från tester, men ska inte få hennes påminnelser.
 */
async function partnerOnly(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db.from("shares").select("owner,viewer");
  if (error) throw new Error("shares: " + error.message);
  const owners = new Set((data ?? []).map((r) => r.owner as string));
  return new Set((data ?? []).map((r) => r.viewer as string).filter((v) => !owners.has(v)));
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du hjälper en person som tar escitalopram i korta omgångar. Hon startar en omgång när premenstruella symtom börjar (symtomstyrd dosering, överenskommen med hennes läkare). Du får hennes dagliga dagbok och hennes tidigare omgångar, och ska bedöma om det är dags igen.

INDATA (JSON):
- "idag": dagens datum.
- "dagar": en rad per loggad dag: "datum", "skattningar" (skala 1-5), "taggar", "anteckning" (hennes egna ord), "sovtimmar" och "uppskattad". Dagar utan rad är ologgade.
- "omgangar": tidigare och ev. pågående omgångar med "start" och "slut".

SKATTNINGAR: för humor, energi och sleepQuality betyder HÖGT bra. För alla andra (irritabilitet, angest, sjalvkritik, kanslighet, intensitet, delusion, magbesvar, stress) betyder HÖGT värre. "uppskattad": true betyder att siffrorna är rekonstruerade i efterhand från hennes anteckningar om perioden. De är grova och ska vägas lägre än dagar loggade i stunden.

UPPGIFT: Bedöm om de SENASTE 1-3 DAGARNA liknar dagarna precis innan hennes tidigare omgångar startade. Väg också in typiskt antal dagar mellan omgångarnas starter mot antalet dagar sedan den senaste omgången tog slut. Jämför med hennes egen data, inte med allmänna antaganden.

Var konservativ: sätt dags=true bara när det finns en verklig likhet i hennes egen data. Vid osäkerhet, för lite data eller otydligt mönster: dags=false. Ge aldrig doseringsråd och ställ aldrig diagnos.

UTDATA (följer schemat):
- dags: boolean.
- sakerhet: "låg", "medel" eller "hög".
- liknar: datum (YYYY-MM-DD) för den tidigare dag som de senaste dagarna mest liknar (t.ex. dagen före en tidigare omgångsstart), eller null.
- text: till henne, på svenska, du-form, varm ton, högst 2 korta meningar. Säg vad det liknar och när, och avsluta med en vänlig puff i stil med "Kanske dags för din tablett?". Tom sträng om dags är false.
- text_partner: en mening på svenska till hennes partner, t.ex. "Det ser ut som att en tyngre period kan vara på väg." Får INTE citera hennes anteckningar eller räkna upp detaljerade symtom. Tom sträng om dags är false.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    dags: { type: "boolean" },
    sakerhet: { type: "string", enum: ["låg", "medel", "hög"] },
    liknar: { anyOf: [{ type: "string" }, { type: "null" }] },
    text: { type: "string" },
    text_partner: { type: "string" },
  },
  required: ["dags", "sakerhet", "liknar", "text", "text_partner"],
  additionalProperties: false,
};

/**
 * Kastar vid nätverks-/API-fel (anroparen släpper då dagens "ai"-plats så att
 * nästa timme får försöka igen). Vägran eller ogiltigt svar = ingen signal.
 */
async function askClaude(client: Anthropic, rows: RecordRow[], today: string): Promise<Signal> {
  const input = buildAiInput(rows, today, AI_DAYS);
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Sonnet 5.5: thinking utelämnas (adaptivt); djupet styrs av effort (medium räcker här).
    output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    // Vägrar modellens säkerhetsklassificerare körs samma anrop om på en annan modell.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });
  if (res.stop_reason === "refusal") return { ...NO_SIGNAL };
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return parseSignalText(text);
}

async function saveSignal(db: SupabaseClient, userId: string, today: string, s: Signal) {
  const now = new Date().toISOString(); // en tidsstämpel, inte ett kalenderdatum
  const { error } = await db.from("records").upsert({
    user_id: userId,
    store: "notes",
    key: "signal",
    data: {
      key: "signal",
      date: today,
      dags: s.dags,
      sakerhet: s.sakerhet,
      liknar: s.liknar,
      text: s.text,
      text_partner: s.text_partner,
      updatedAt: now,
    },
    deleted_at: null,
  }, { onConflict: "user_id,store,key" });
  if (error) throw new Error("records upsert: " + error.message);
}

// ---------------------------------------------------------------------------
// Per ägare
// ---------------------------------------------------------------------------

interface Summary {
  owners: number;
  med: number;
  logg: number;
  ai: number; // antal AI-anrop som gjordes
  signal: number; // antal signaler som skickades (till henne)
  partner: number; // antal partnernotiser
  removed: number; // borttagna döda prenumerationer
  errors: string[];
  dry?: Record<string, unknown>[];
}

async function runOwner(
  db: SupabaseClient,
  client: Anthropic,
  owner: string,
  now: { day: string; hour: number },
  dry: boolean,
  sum: Summary,
) {
  const today = now.day;
  const rows = await loadRows(db, owner, today);
  const report: Record<string, unknown> = { owner: owner.slice(0, 8) };
  const gate = (k: "med" | "logg" | "ai") => dry || hourEligible(k, now.hour);

  // --- med ---------------------------------------------------------------
  if (gate("med") && needsMedReminder(rows, today)) {
    report.med = "skulle skickas";
    if (!dry) {
      const subs = await subsOf(db, owner);
      if (subs.length && await claim(db, owner, "med", today)) {
        const c = await pushToSubs(db, subs, {
          title: "Dags att ta escitalopram 💊",
          body: "Glöm inte din tablett idag.",
          view: "medicin",
        });
        sum.removed += c.removed;
        if (c.sent > 0) sum.med++;
        else await release(db, owner, "med", today); // inget nådde fram: försök igen nästa timme
      }
    }
  }

  // --- logg --------------------------------------------------------------
  if (gate("logg") && needsLogReminder(rows, today)) {
    report.logg = "skulle skickas";
    if (!dry) {
      const subs = await subsOf(db, owner);
      if (subs.length && await claim(db, owner, "logg", today)) {
        const c = await pushToSubs(db, subs, {
          title: "Hur har dagen varit? 💗",
          body: "En snabb check-in hjälper dig se mönster.",
          view: "maende",
        });
        sum.removed += c.removed;
        if (c.sent > 0) sum.logg++;
        else await release(db, owner, "logg", today);
      }
    }
  }

  // --- ai ----------------------------------------------------------------
  if (gate("ai")) {
    const skip = aiSkipReason(rows, today);
    if (skip) {
      report.ai = "hoppas över: " + skip;
    } else if (dry) {
      const s = await askClaude(client, rows, today);
      sum.ai++;
      const recent = await recentSignalLogged(db, owner, today);
      report.ai = { ...s, skulle_notifiera: s.dags && !recent, signal_inom_4_dagar: recent };
    } else if (await claim(db, owner, "ai", today)) {
      let s: Signal;
      try {
        s = await askClaude(client, rows, today);
      } catch (e) {
        await release(db, owner, "ai", today); // API-fel: nästa timme får försöka
        throw e;
      }
      sum.ai++;
      await saveSignal(db, owner, today, s);
      if (s.dags && !(await recentSignalLogged(db, owner, today))) {
        if (await claim(db, owner, "signal", today)) {
          const own = await subsOf(db, owner);
          const c = await pushToSubs(db, own, {
            title: "Känner du igen det här? 💗",
            body: s.text,
            view: "idag",
          });
          sum.removed += c.removed;
          let delivered = c.sent > 0;
          for (const v of await viewersOf(db, owner)) {
            const pc = await pushToSubs(db, await subsOf(db, v), {
              title: "Antonias dagbok",
              body: s.text_partner,
              view: "idag",
            });
            sum.removed += pc.removed;
            if (pc.sent > 0) {
              sum.partner++;
              delivered = true;
            }
          }
          if (c.sent > 0) sum.signal++;
          // Ingen nådde fram alls: släpp platsen så att nästa timme får försöka.
          if (!delivered) await release(db, owner, "signal", today);
        }
      }
    }
  }

  if (dry) sum.dry!.push(report);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  let env: Env;
  try {
    env = loadEnv();
  } catch (e) {
    // Vilka hemligheter som saknas hör hemma i funktionsloggen, inte i svaret
    // till en anropare som ännu inte har visat sig behörig.
    console.error((e as Error).message);
    return json({ error: "funktionen är inte färdigkonfigurerad" }, 500);
  }
  if (req.headers.get("x-cron-secret") !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let body: { test?: boolean; dry?: boolean } = {};
  try {
    const t = await req.text();
    if (t.trim()) body = JSON.parse(t);
  } catch (_) {
    return json({ error: "ogiltig JSON" }, 400);
  }

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- test: testnotis till alla prenumerationer -----------------------------
  if (body.test === true) {
    try {
      const { data, error } = await db.from("push_subscriptions").select("endpoint,p256dh,auth");
      if (error) throw new Error("push_subscriptions: " + error.message);
      const c = await pushToSubs(db, (data ?? []) as Sub[], {
        title: "Testnotis",
        body: "Notiserna fungerar ✓",
        view: "idag",
      });
      return json({ test: true, ...c });
    } catch (e) {
      return json({ test: true, error: (e as Error).message }, 500);
    }
  }

  // --- dagligt jobb (eller dry) ------------------------------------------------
  const dry = body.dry === true;
  const now = stockholmNow();
  const sum: Summary = {
    owners: 0, med: 0, logg: 0, ai: 0, signal: 0, partner: 0, removed: 0, errors: [],
    ...(dry ? { dry: [] } : {}),
  };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let owners: string[];
  try {
    const skip = await partnerOnly(db);
    owners = (await listOwners(db)).filter((o) => !skip.has(o));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  sum.owners = owners.length;
  for (const owner of owners) {
    try {
      await runOwner(db, client, owner, now, dry, sum);
    } catch (e) {
      // Bara felmeddelandet, aldrig data. Ingen anteckningstext når hit.
      sum.errors.push(owner.slice(0, 8) + ": " + (e as Error).message);
    }
  }
  return json({ ...sum, dry: dry ? sum.dry : undefined, day: now.day, hour: now.hour, mode: dry ? "dry" : "run" });
});
