import { assertEquals } from "jsr:@std/assert@1";
import { DEFAULT_HOURS, hourEligible, hourWindow, notifyHours, type RecordRow } from "./logic.ts";

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
