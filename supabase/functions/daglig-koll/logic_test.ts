import { assertEquals } from "jsr:@std/assert@1";
import { buildAiInput, DEFAULT_HOURS, hourEligible, hourWindow, notifyHours, parseSignal, scrubSignal, type RecordRow } from "./logic.ts";

// Hjälp: bygg en notis-tider-rad.
const row = (data: Record<string, unknown> | null, deleted_at: string | null = null): RecordRow => ({
  store: "notes",
  key: "notis-tider",
  data,
  deleted_at,
});

Deno.test("notifyHours: standard utan rad", () => {
  assertEquals(notifyHours([]), DEFAULT_HOURS);
});

Deno.test("notifyHours: läser giltiga värden (även 0)", () => {
  assertEquals(notifyHours([row({ logg: 19, med: 0 })]), { logg: 19, med: 0 });
});

Deno.test("notifyHours: raderad rad ger standard", () => {
  assertEquals(notifyHours([row({ logg: 19, med: 7 }, "2026-01-01")]), DEFAULT_HOURS);
  assertEquals(notifyHours([row({ logg: 19, med: 7, deletedAt: "x" })]), DEFAULT_HOURS);
});

Deno.test("notifyHours: ogiltiga värden ger standard per fält", () => {
  assertEquals(notifyHours([row({ logg: 24, med: "7" })]), DEFAULT_HOURS);
  assertEquals(notifyHours([row({ logg: 20.5, med: 7 })]), { logg: 21, med: 7 });
  assertEquals(notifyHours([row({ logg: -1, med: null })]), DEFAULT_HOURS);
});

Deno.test("hourWindow: tre timmar, kapas vid 23", () => {
  assertEquals(hourWindow("logg", { logg: 21, med: 9 }), [21, 23]);
  assertEquals(hourWindow("logg", { logg: 23, med: 9 }), [23, 23]);
  assertEquals(hourWindow("med", { logg: 21, med: 9 }), [9, 11]);
  assertEquals(hourWindow("ai"), [21, 23]);
});

Deno.test("hourEligible: gränser", () => {
  const h = { logg: 18, med: 7 };
  assertEquals(hourEligible("logg", 17, h), false);
  assertEquals(hourEligible("logg", 18, h), true);
  assertEquals(hourEligible("logg", 20, h), true);
  assertEquals(hourEligible("logg", 21, h), false);
  assertEquals(hourEligible("med", 9, h), true);
  assertEquals(hourEligible("med", 10, h), false);
  assertEquals(hourEligible("ai", 20), false);
  assertEquals(hourEligible("ai", 21), true);
  // Standard utan hours-argument
  assertEquals(hourEligible("med", 9), true);
  assertEquals(hourEligible("logg", 20), false);
});

// --- buildAiInput: blödningar, kartstarter, uppehåll ----------------------------
const TODAY = "2026-06-30";
// Fönster på 10 dagar: 2026-06-21 .. 2026-06-30
const mk = (store: string, key: string, data: Record<string, unknown>, deleted_at: string | null = null): RecordRow => ({
  store,
  key,
  data,
  deleted_at,
});

Deno.test("buildAiInput: blödningar inom fönstret sorteras, utanför och raderade hoppas över", () => {
  const rows = [
    mk("bleeding", "u2", { date: "2026-06-25", type: "bortfall", flow: "medel" }),
    mk("bleeding", "u1", { date: "2026-06-22", type: "mellanblodning", flow: "spotting" }),
    mk("bleeding", "u3", { date: "2026-06-20", type: "bortfall", flow: "latt" }), // före fönstret
    mk("bleeding", "u4", { date: "2026-06-26", type: "framslappt", flow: "latt" }, "2026-06-27"), // raderad
    mk("bleeding", "u5", { date: "2026-06-27", type: "bortfall", flow: "latt", deletedAt: "x" }), // raderad
  ];
  assertEquals(buildAiInput(rows, TODAY, 10).blodningar, [
    { datum: "2026-06-22", typ: "mellanblodning", flode: "spotting" },
    { datum: "2026-06-25", typ: "bortfall", flode: "medel" },
  ]);
});

Deno.test("buildAiInput: kartstarter inom fönstret", () => {
  const rows = [
    mk("notes", "ppiller:2026-06-28", { key: "ppiller:2026-06-28", date: "2026-06-28" }),
    mk("notes", "ppiller:2026-06-01", { key: "ppiller:2026-06-01", date: "2026-06-01" }), // utanför
    mk("notes", "ppiller:2026-06-23", { key: "ppiller:2026-06-23", date: "2026-06-23" }, "2026-06-24"), // raderad
    mk("notes", "helps", { key: "helps", date: "2026-06-29" }), // annan not
  ];
  assertEquals(buildAiInput(rows, TODAY, 10).kartstarter, ["2026-06-28"]);
});

Deno.test("buildAiInput: uppehåll pågående, avslutat och utanför fönstret", () => {
  const rows = [
    mk("notes", "ppaus:2026-06-28", { key: "ppaus:2026-06-28", start: "2026-06-28", end: null }),
    mk("notes", "ppaus:2026-06-15", { key: "ppaus:2026-06-15", start: "2026-06-15", end: "2026-06-22" }), // slutar i fönstret
    mk("notes", "ppaus:2026-06-10", { key: "ppaus:2026-06-10", start: "2026-06-10", end: "2026-06-21" }), // slut = fönstrets start: ingen uppehållsdag i fönstret
    mk("notes", "ppaus:2026-05-01", { key: "ppaus:2026-05-01", start: "2026-05-01", end: "2026-05-06" }), // långt före
    mk("notes", "ppaus:2026-06-24", { key: "ppaus:2026-06-24", start: "2026-06-24", end: "2026-06-26" }, "2026-06-27"), // raderad
  ];
  assertEquals(buildAiInput(rows, TODAY, 10).uppehall, [
    { start: "2026-06-15", slut: "2026-06-22", pagar: false },
    { start: "2026-06-28", slut: null, pagar: true },
  ]);
});

Deno.test("buildAiInput: dagar och omgångar oförändrade, nya listor tomma utan data", () => {
  const rows = [
    mk("mood", "2026-06-29", { scores: { humor: 4, stress: 2 }, tags: ["a"], note: "hej", sleepHours: 7 }),
    mk("courses", "1", { startdatum: "2026-06-01", slutdatum: "2026-06-05", active: false }),
  ];
  const input = buildAiInput(rows, TODAY, 10);
  assertEquals(input.dagar, [{
    datum: "2026-06-29",
    skattningar: { humor: 4, stress: 2 },
    taggar: ["a"],
    anteckning: "hej",
    sovtimmar: 7,
    uppskattad: false,
  }]);
  assertEquals(input.omgangar, [{ start: "2026-06-01", slut: "2026-06-05", pagar: false }]);
  assertEquals(input.blodningar, []);
  assertEquals(input.kartstarter, []);
  assertEquals(input.uppehall, []);
});

Deno.test("scrubSignal: byter ut text_partner som nämner känsliga ord", () => {
  const s = scrubSignal({ dags: true, sakerhet: "medel", liknar: null, text: "Hej, det liknar förra gången.", text_partner: "Efter uppehållet i p-pillren kan det bli tungt." });
  assertEquals(s.text_partner, "Det ser ut som att en tyngre period kan vara på väg.");
  assertEquals(s.text, "Hej, det liknar förra gången.");
});

Deno.test("scrubSignal: byter ut text som nämner blödning men tillåter uppehåll", () => {
  const bad = scrubSignal({ dags: true, sakerhet: "låg", liknar: null, text: "Din bortfallsblödning liknar förra gången.", text_partner: "Ta det lugnt." });
  assertEquals(bad.text, "Dina senaste dagar liknar en tidigare period som blev tyngre. Kanske dags att känna efter?");
  assertEquals(bad.text_partner, "Ta det lugnt.");
  const ok = scrubSignal({ dags: true, sakerhet: "låg", liknar: null, text: "Efter förra uppehållet blev det tungt.", text_partner: "Ta det lugnt." });
  assertEquals(ok.text, "Efter förra uppehållet blev det tungt.");
});

Deno.test("scrubSignal: fångar omskrivningar", () => {
  const safeP = "Det ser ut som att en tyngre period kan vara på väg.";
  for (const t of ["Cykeln verkar vara på väg igen.", "Den röda veckan närmar sig.", "Hon har slutat med preventivmedlet.", "Hormonerna ställer till det."]) {
    assertEquals(scrubSignal({ dags: true, sakerhet: "låg", liknar: null, text: "Hej.", text_partner: t }).text_partner, safeP);
  }
  const s = scrubSignal({ dags: true, sakerhet: "låg", liknar: null, text: "Det liknar de röda dagarna.", text_partner: "Ta det lugnt." });
  assertEquals(s.text, "Dina senaste dagar liknar en tidigare period som blev tyngre. Kanske dags att känna efter?");
});

Deno.test("parseSignal: dags=true skrubbas", () => {
  const s = parseSignal({ dags: true, sakerhet: "hög", liknar: "2026-01-02", text: "Mens på väg.", text_partner: "Mens på väg." });
  assertEquals(s.text, "Dina senaste dagar liknar en tidigare period som blev tyngre. Kanske dags att känna efter?");
  assertEquals(s.text_partner, "Det ser ut som att en tyngre period kan vara på väg.");
});

Deno.test("buildAiInput: egna snabbval mappas till etikett, även borttagna; okända lämnas", () => {
  const rows = [
    mk("notes", "tags", { custom: [{ id: "egen-a", label: "Promenad" }, { id: "egen-b", label: "Bråk", removed: true }] }),
    mk("mood", "2026-06-29", { scores: { humor: 3 }, tags: ["egen-a", "egen-b", "egen-x", "sov-dalig"] }),
  ];
  assertEquals(buildAiInput(rows, TODAY, 10).dagar[0].taggar, ["Promenad", "Bråk", "egen-x", "sov-dalig"]);
});
