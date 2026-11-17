// Rena hjälpfunktioner för daglig-koll (inga nätverksanrop, ingen Deno-API).
// Ligger i egen fil så att de går att testa utan att starta servern.

export const TZ = "Europe/Stockholm";

export type Kind = "med" | "logg" | "ai" | "signal";

/** Rad ur public.records, de kolumner funktionen läser. */
export interface RecordRow {
  store: string;
  key: string;
  data: Record<string, unknown> | null;
  deleted_at: string | null;
}

export interface Signal {
  dags: boolean;
  sakerhet: "låg" | "medel" | "hög";
  liknar: string | null;
  text: string;
  text_partner: string;
}

export const NO_SIGNAL: Signal = {
  dags: false,
  sakerhet: "låg",
  liknar: null,
  text: "",
  text_partner: "",
};

// Skalor där HÖGT är bra. Alla andra: högt är värre.
export const GOOD_HIGH = ["humor", "energi", "sleepQuality"];

// ---------------------------------------------------------------------------
// Datum och tid (alltid svensk lokal tid, aldrig toISOString().slice(0, 10))
// ---------------------------------------------------------------------------

/** { day: "YYYY-MM-DD", hour: 0..23 } i Europe/Stockholm för ett givet ögonblick. */
export function stockholmNow(now: Date = new Date()): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
  };
}

/** Flytta ett YYYY-MM-DD n dagar (kalenderaritmetik, ingen tidszon inblandad). */
export function shiftDay(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Hennes valda notistimmar (svensk tid, heltal 0-23). */
export interface NotifyHours {
  logg: number;
  med: number;
}

/** Standard när inget (giltigt) val finns: kvällspåminnelse 21, tablett 9. */
export const DEFAULT_HOURS: NotifyHours = { logg: 21, med: 9 };

/** Hur många timmar ett fönster varar (vald timme + 2), så en missad körning ger nya försök. */
const WINDOW_SPAN = 2;

/** "ai" har ett fast fönster (inklusive), svensk tid. */
export const AI_WINDOW: [number, number] = [21, 23];

function validHour(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
}

/**
 * Läser notes/notis-tider ur raderna. Raderad rad eller ogiltigt värde
 * (inte heltal 0-23) ger standardvärdet för just det fältet.
 */
export function notifyHours(rows: RecordRow[]): NotifyHours {
  const row = liveRows(rows, "notes").find((r) => r.key === "notis-tider");
  const d = row?.data ?? {};
  return {
    logg: validHour(d["logg"]) ? d["logg"] : DEFAULT_HOURS.logg,
    med: validHour(d["med"]) ? d["med"] : DEFAULT_HOURS.med,
  };
}

/** Timfönster (inklusive) för en sort: vald timme h till min(h+2, 23). */
export function hourWindow(kind: "med" | "logg" | "ai", hours: NotifyHours = DEFAULT_HOURS): [number, number] {
  if (kind === "ai") return AI_WINDOW;
  const h = hours[kind];
  return [h, Math.min(h + WINDOW_SPAN, 23)];
}

/** Är klockslaget (0-23) inom sortens fönster? */
export function hourEligible(
  kind: "med" | "logg" | "ai",
  hour: number,
  hours: NotifyHours = DEFAULT_HOURS,
): boolean {
  const [a, b] = hourWindow(kind, hours);
  return hour >= a && hour <= b;
}

// ---------------------------------------------------------------------------
// Rader och eligibility
// ---------------------------------------------------------------------------

export function isDeleted(r: RecordRow): boolean {
  return r.deleted_at != null || (r.data != null && r.data["deletedAt"] != null &&
    r.data["deletedAt"] !== false && r.data["deletedAt"] !== "");
}

export function liveRows(rows: RecordRow[], store: string): RecordRow[] {
  return rows.filter((r) => r.store === store && !isDeleted(r));
}

export function hasActiveCourse(rows: RecordRow[]): boolean {
  return liveRows(rows, "courses").some((r) => r.data?.["active"] === true);
}

export function hasMedToday(rows: RecordRow[], today: string): boolean {
  return liveRows(rows, "medication").some((r) => r.data?.["date"] === today);
}

export function hasMood(rows: RecordRow[], day: string): boolean {
  return liveRows(rows, "mood").some((r) => r.key === day);
}

export function needsMedReminder(rows: RecordRow[], today: string): boolean {
  return hasActiveCourse(rows) && !hasMedToday(rows, today);
}

export function needsLogReminder(rows: RecordRow[], today: string): boolean {
  return !hasMood(rows, today);
}

/** AI-kollen körs bara utan aktiv omgång och med en loggad dag idag eller igår. */
export function aiSkipReason(rows: RecordRow[], today: string): string | null {
  if (hasActiveCourse(rows)) return "active_course";
  if (!hasMood(rows, today) && !hasMood(rows, shiftDay(today, -1))) return "no_recent_mood";
  return null;
}

/** Tyngd 1..5 för en skattning: 6 - v för "högt är bra", annars v. */
export function heaviness(metric: string, v: number): number {
  return GOOD_HIGH.includes(metric) ? 6 - v : v;
}

/** Medel av tyngden i en dags skattningar, eller null. */
export function dayLevel(scores: Record<string, unknown> | undefined): number | null {
  if (!scores) return null;
  const hs: number[] = [];
  for (const [k, v] of Object.entries(scores)) {
    if (typeof v === "number" && v >= 1 && v <= 5) hs.push(heaviness(k, v));
  }
  return hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
}

// ---------------------------------------------------------------------------
// Indata till Claude
// ---------------------------------------------------------------------------

export interface AiInput {
  idag: string;
  dagar: Array<{
    datum: string;
    skattningar: Record<string, number>;
    taggar: string[];
    anteckning: string;
    sovtimmar: number | null;
    uppskattad: boolean;
  }>;
  omgangar: Array<{ start: string; slut: string | null; pagar: boolean }>;
}

/** Senaste `days` dagarna (inklusive idag) + alla omgångar. Inget kapas inom intervallet. */
export function buildAiInput(rows: RecordRow[], today: string, days = 150): AiInput {
  const from = shiftDay(today, -(days - 1));
  const dagar = liveRows(rows, "mood")
    .filter((r) => r.key >= from && r.key <= today)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((r) => {
      const d = r.data ?? {};
      const scores: Record<string, number> = {};
      const raw = d["scores"];
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "number") scores[k] = v;
        }
      }
      return {
        datum: r.key,
        skattningar: scores,
        taggar: Array.isArray(d["tags"]) ? (d["tags"] as unknown[]).map(String) : [],
        anteckning: typeof d["note"] === "string" ? (d["note"] as string) : "",
        sovtimmar: typeof d["sleepHours"] === "number" ? (d["sleepHours"] as number) : null,
        uppskattad: d["estimated"] === true,
      };
    });
  const omgangar = liveRows(rows, "courses")
    .map((r) => ({
      start: String(r.data?.["startdatum"] ?? ""),
      slut: r.data?.["slutdatum"] ? String(r.data["slutdatum"]) : null,
      pagar: r.data?.["active"] === true,
    }))
    .filter((c) => c.start)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  return { idag: today, dagar, omgangar };
}

// ---------------------------------------------------------------------------
// Svar från Claude → Signal (ogiltigt = ingen signal)
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseSignal(raw: unknown): Signal {
  if (!raw || typeof raw !== "object") return { ...NO_SIGNAL };
  const o = raw as Record<string, unknown>;
  if (typeof o.dags !== "boolean") return { ...NO_SIGNAL };
  if (o.sakerhet !== "låg" && o.sakerhet !== "medel" && o.sakerhet !== "hög") return { ...NO_SIGNAL };
  if (typeof o.text !== "string" || typeof o.text_partner !== "string") return { ...NO_SIGNAL };
  const liknar = typeof o.liknar === "string" && ISO.test(o.liknar) ? o.liknar : null;
  // dags utan text vore en tom notis: behandla som ingen signal.
  if (o.dags && (!o.text.trim() || !o.text_partner.trim())) return { ...NO_SIGNAL };
  if (!o.dags) return { dags: false, sakerhet: o.sakerhet, liknar, text: "", text_partner: "" };
  return {
    dags: true,
    sakerhet: o.sakerhet,
    liknar,
    text: o.text.trim(),
    text_partner: o.text_partner.trim(),
  };
}

/** Försök hämta JSON ur svarstexten (strukturerad utdata ger ren JSON). */
export function parseSignalText(text: string): Signal {
  try {
    return parseSignal(JSON.parse(text));
  } catch (_) {
    return { ...NO_SIGNAL };
  }
}
