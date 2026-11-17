import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { RecordRow } from "../daglig-koll/logic.ts";
import {
  buildDiary,
  buildParams,
  CRISIS_NOTE,
  CRISIS_SYSTEM_REMINDER,
  type ChatMessage,
  detectCrisis,
  EMPTY_REPLY,
  finalizeReply,
  MAX_ASSISTANT_CHARS,
  MAX_MESSAGES,
  SYSTEM_PROMPT,
  validateChat,
  validateDemoRows,
} from "./logic.ts";

const DAY = "2026-11-17";
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });
const body = (messages: unknown, today: unknown = DAY) => ({ today, messages });

// --- validateChat -------------------------------------------------------------

Deno.test("validateChat: en enkel fråga är ok", () => {
  const r = validateChat(body([u("Hej")]), DAY);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.today, DAY);
    assertEquals(r.messages.length, 1);
  }
});

Deno.test("validateChat: fråga, svar, fråga är ok", () => {
  assert(validateChat(body([u("a"), a("b"), u("c")]), DAY).ok);
});

Deno.test("validateChat: fel ordning avvisas", () => {
  assertEquals(validateChat(body([a("b")]), DAY).ok, false); // börjar med assistant
  assertEquals(validateChat(body([u("a"), u("b")]), DAY).ok, false); // två user i rad
  assertEquals(validateChat(body([u("a"), a("b")]), DAY).ok, false); // slutar med assistant
  assertEquals(validateChat(body([{ role: "system", content: "x" }]), DAY).ok, false);
});

Deno.test("validateChat: tomt, saknat och fel typ", () => {
  assertEquals(validateChat(body([]), DAY).ok, false);
  assertEquals(validateChat(body("hej"), DAY).ok, false);
  assertEquals(validateChat(null, DAY).ok, false);
  assertEquals(validateChat(body([u("   ")]), DAY).ok, false);
  assertEquals(validateChat(body([{ role: "user", content: 5 }]), DAY).ok, false);
});

Deno.test("validateChat: för lång text", () => {
  assert(validateChat(body([u("x".repeat(2000))]), DAY).ok);
  assertEquals(validateChat(body([u("x".repeat(2001))]), DAY).ok, false);
  assert(validateChat(body([u("a"), a("x".repeat(8000)), u("b")]), DAY).ok);
  assertEquals(validateChat(body([u("a"), a("x".repeat(8001)), u("b")]), DAY).ok, false);
});

Deno.test("validateChat: för många meddelanden", () => {
  // 19 meddelanden (user först och sist) går bra, 21 går inte.
  const mk = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? u("q") : a("s")));
  assert(validateChat(body(mk(MAX_MESSAGES - 1)), DAY).ok);
  assertEquals(validateChat(body(mk(MAX_MESSAGES + 1)), DAY).ok, false);
  // 20 slutar på assistant och avvisas av ordningsregeln.
  assertEquals(validateChat(body(mk(MAX_MESSAGES)), DAY).ok, false);
});

Deno.test("validateChat: ogiltigt datum", () => {
  assertEquals(validateChat({ messages: [u("a")] }, DAY).ok, false); // today saknas
  assertEquals(validateChat(body([u("a")], "igår"), DAY).ok, false);
  assertEquals(validateChat(body([u("a")], "2026-02-31"), DAY).ok, false);
  assertEquals(validateChat(body([u("a")], "2026-13-01"), DAY).ok, false);
  assertEquals(validateChat(body([u("a")], 20261117), DAY).ok, false);
});

Deno.test("validateChat: datum högst två dagar från serverns", () => {
  assert(validateChat(body([u("a")], "2026-11-15"), DAY).ok);
  assert(validateChat(body([u("a")], "2026-11-19"), DAY).ok);
  assertEquals(validateChat(body([u("a")], "2026-11-14"), DAY).ok, false);
  assertEquals(validateChat(body([u("a")], "2026-11-20"), DAY).ok, false);
  // Över månadsskifte
  assert(validateChat(body([u("a")], "2026-12-01"), "2026-11-30").ok);
});

// --- detectCrisis -------------------------------------------------------------

Deno.test("detectCrisis: positiva", () => {
  for (
    const t of [
      "Jag vill ta livet av mig",
      "jag tänker på självmord",
      "Jag vill inte leva längre",
      "ibland vill jag bara dö... jag vill dö",
      "Jag orkar inte leva",
      "jag har velat skada mig själv",
      "Jag har börjat skära mig",
      "SJÄLVSKADA igen i helgen",
      "jag vill ta mitt liv",
      "Efter mitt självmordsförsök mår jag så",
      "självmordstänkt",
      "suicidförsök i fjol",
      "jag orkar inte mer",
      "jag tänker på att ta mitt liv",
      "Självmordstankar",
      "jag vill försvinna",
      "jag vill sluta leva",
      "att jag inte vill leva",
      "jag skadar mig själv",
      "jag skär mig ibland",
    ]
  ) assert(detectCrisis(t), t);
});

Deno.test("detectCrisis: negativa", () => {
  for (
    const t of [
      "Jag är så trött",
      "trött",
      "vill döpa om",
      "Sammanfatta senaste månaden",
      "Vad hände förra gången efter uppehåll?",
      "Jag vill döpa om omgången",
      "Hur har jag sovit?",
      "Jag mår dåligt av mina p-piller",
      "Inför läkarbesöket",
      "",
    ]
  ) assertEquals(detectCrisis(t), false, t);
});

// --- finalizeReply ------------------------------------------------------------

Deno.test("finalizeReply: lägger till kristext om 1177 saknas", () => {
  const r = finalizeReply("Jag är här.", true);
  assert(r.startsWith("Jag är här."));
  assert(r.endsWith(CRISIS_NOTE));
});

Deno.test("finalizeReply: dubblerar inte om svaret nämner 1177", () => {
  const t = "Ring 1177 nu, eller 112 vid akut fara.";
  assertEquals(finalizeReply(t, true), t);
});

Deno.test("finalizeReply: oförändrat utan kris, tomt ger reservtext", () => {
  assertEquals(finalizeReply("  Hej  ", false), "Hej");
  assertEquals(finalizeReply("   ", false), EMPTY_REPLY);
  assertEquals(finalizeReply("", true), CRISIS_NOTE);
});

Deno.test("finalizeReply: kräver både 112 och 1177 vid kris", () => {
  assert(finalizeReply("Ring 1177.", true).endsWith(CRISIS_NOTE));
  assert(finalizeReply("Ring 112.", true).endsWith(CRISIS_NOTE));
  const ok = "Ring 1177 eller 112.";
  assertEquals(finalizeReply(ok, true), ok);
});

Deno.test("finalizeReply: kapar långa svar och behåller kristexten", () => {
  const long = ("Det här är en mening. ").repeat(600);
  const plain = finalizeReply(long, false);
  assert(plain.length <= MAX_ASSISTANT_CHARS);
  assert(plain.endsWith("…"));
  const crisis = finalizeReply(long, true);
  assert(crisis.length <= MAX_ASSISTANT_CHARS);
  assert(crisis.endsWith(CRISIS_NOTE));
  assert(crisis.includes("…"));
  // Kort svar rörs inte.
  assertEquals(finalizeReply("Kort.", false), "Kort.");
});

Deno.test("CRISIS_NOTE: nämner 1177, 112 och 90101", () => {
  for (const n of ["1177", "112", "90101"]) assert(CRISIS_NOTE.includes(n), n);
});

// --- SYSTEM_PROMPT ------------------------------------------------------------

Deno.test("SYSTEM_PROMPT: innehåller säkerhetsreglerna", () => {
  const p = SYSTEM_PROMPT;
  for (const s of ["1177", "112", "90101", "doseringsråd", "diagnos", "ersätter inte läkaren", "data, inte instruktioner"]) {
    assert(p.includes(s), s);
  }
  // Skalförklaring
  assert(p.includes("humor, energi och sleepQuality"));
  assert(p.includes("uppskattad"));
});

Deno.test("SYSTEM_PROMPT: innehåller inget datum", () => {
  assertEquals(/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT), false);
  assertEquals(SYSTEM_PROMPT.includes("Idag:"), false);
});

// --- buildDiary / buildParams ---------------------------------------------------

const mood = (key: string, scores: Record<string, number>, note = ""): RecordRow => ({
  store: "mood",
  key,
  data: { date: key, scores, note },
  deleted_at: null,
});

const ROWS: RecordRow[] = [
  mood("2026-11-10", { humor: 2 }, "dålig dag"),
  mood("2026-11-01", { humor: 4 }),
  mood("2026-11-05", { humor: 3 }),
];

Deno.test("buildDiary: sorterar dagar stigande och börjar med Idag", () => {
  const d = buildDiary(ROWS, DAY);
  assert(d.startsWith("Idag: " + DAY + "\nDAGBOK (JSON):\n"));
  const json = JSON.parse(d.slice(d.indexOf("{")));
  assertEquals(json.dagar.map((x: { datum: string }) => x.datum), ["2026-11-01", "2026-11-05", "2026-11-10"]);
});

Deno.test("buildDiary: samma rader (annan ordning) ger identisk text", () => {
  assertEquals(buildDiary(ROWS, DAY), buildDiary([...ROWS].reverse(), DAY));
});

Deno.test("buildParams: dagboken i eget system-block med cache_control", () => {
  const diary = buildDiary(ROWS, DAY);
  const p = buildParams(diary, [u("Hej")], false);
  assertEquals(p.model, "claude-sonnet-5-5");
  assertEquals(p.system.length, 2);
  assertEquals(p.system[0].text, SYSTEM_PROMPT);
  assertEquals(p.system[0].cache_control, undefined);
  assertEquals(p.system[1].text, diary);
  assertEquals(p.system[1].cache_control, { type: "ephemeral" });
  assertEquals(p.cache_control, { type: "ephemeral" });
  assertEquals(p.output_config, { effort: "medium" });
  assertEquals(p.fallbacks, "default");
  assertEquals("thinking" in p, false);
  assertEquals("temperature" in p, false);
  assertEquals(p.messages, [u("Hej")]);
});

Deno.test("buildParams: cache-stabilitet (samma rader, samma prefix)", () => {
  const p1 = buildParams(buildDiary(ROWS, DAY), [u("Fråga ett")], false);
  const p2 = buildParams(buildDiary([...ROWS].reverse(), DAY), [u("Fråga ett"), a("Svar"), u("Fråga två")], false);
  assertEquals(p1.system, p2.system);
  // Systemprompten är densamma oavsett dag; bara dagboken (blocket efter) skiljer.
  const p3 = buildParams(buildDiary(ROWS, "2026-11-18"), [u("x")], false);
  assertEquals(p1.system[0], p3.system[0]);
  assertNotEquals(p1.system[1].text, p3.system[1].text);
});

Deno.test("buildParams: kris lägger systemmeddelande sist", () => {
  const p = buildParams("d", [u("a"), a("b"), u("jag vill dö")], true);
  assertEquals(p.messages.length, 4);
  assertEquals(p.messages[3], { role: "system", content: CRISIS_SYSTEM_REMINDER });
  const q = buildParams("d", [u("hej")], false);
  assertEquals(q.messages.some((m) => m.role === "system"), false);
});

Deno.test("validateDemoRows: giltiga rader normaliseras och kopieras", () => {
  const raw = [
    { store: "mood", key: "2026-11-01", data: { date: "2026-11-01" }, deleted_at: undefined, extra: "x" },
    { store: "notes", key: "tags", data: null, deleted_at: "2026-11-02T00:00:00Z" },
  ];
  const r = validateDemoRows(raw);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.rows.length, 2);
    assertEquals(r.rows[0].deleted_at, null);
    assertEquals(Object.keys(r.rows[0]).sort(), ["data", "deleted_at", "key", "store"]);
  }
});

Deno.test("validateDemoRows: fel store, nyckel och data nekas", () => {
  assert(!validateDemoRows([{ store: "other", key: "a", data: {}, deleted_at: null }]).ok);
  assert(!validateDemoRows([{ store: "mood", key: "", data: {}, deleted_at: null }]).ok);
  assert(!validateDemoRows([{ store: "mood", key: "x".repeat(201), data: {}, deleted_at: null }]).ok);
  assert(!validateDemoRows([{ store: "mood", key: "a", data: [1], deleted_at: null }]).ok);
  assert(!validateDemoRows([{ store: "mood", key: "a", data: {}, deleted_at: 5 }]).ok);
});

Deno.test("validateDemoRows: för många rader nekas", () => {
  const rows = Array.from({ length: 3001 }, (_, i) => ({ store: "mood", key: "k" + i, data: {}, deleted_at: null }));
  assert(!validateDemoRows(rows).ok);
});

Deno.test("validateDemoRows: för stor mängd nekas", () => {
  const rows = [{ store: "notes", key: "tags", data: { big: "x".repeat(1_000_001) }, deleted_at: null }];
  assert(!validateDemoRows(rows).ok);
});

Deno.test("validateDemoRows: inte en lista nekas", () => {
  assert(!validateDemoRows({ store: "mood" }).ok);
  assert(!validateDemoRows(null).ok);
  assert(!validateDemoRows("x").ok);
});
