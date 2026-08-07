const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { DEFAULT_USER_TIMEZONE } = require("../dist/config/limits.config");
const {
  getCalendarDayRange,
  getLocalDateKey,
  latestSlotAtOrBefore,
  nextSlotAtOrAfter,
  nextSlotStrictlyAfter,
  resolveEffectiveTimeZone,
  resolveWallClock,
  validateScheduleTime,
} = require("../dist/shared/time/timezone");

function assertSlot(slot, expectedInstant, expectedLocalDate, expectedTimeZone) {
  assert.equal(slot.instant.toISOString(), expectedInstant);
  assert.equal(slot.localDate, expectedLocalDate);
  assert.equal(slot.timeZone, expectedTimeZone);
}

test("resolveEffectiveTimeZone preserves canonical zones and normalizes aliases", () => {
  assert.deepEqual(resolveEffectiveTimeZone("Europe/Moscow"), {
    timeZone: "Europe/Moscow",
    usedFallback: false,
    wasNormalized: false,
  });

  const alias = "US/Eastern";
  const expectedCanonical = new Intl.DateTimeFormat("en-US", {
    timeZone: alias,
  }).resolvedOptions().timeZone;

  assert.notEqual(expectedCanonical, alias);
  assert.deepEqual(resolveEffectiveTimeZone(alias), {
    timeZone: expectedCanonical,
    usedFallback: false,
    wasNormalized: true,
  });
});

test("resolveEffectiveTimeZone falls back for blank and invalid legacy values", () => {
  for (const value of [undefined, null, "", "   ", "Not/A_Timezone"]) {
    assert.deepEqual(resolveEffectiveTimeZone(value), {
      timeZone: DEFAULT_USER_TIMEZONE,
      usedFallback: true,
      wasNormalized: false,
    });
  }
});

test("validateScheduleTime rejects invalid hours and minutes", () => {
  for (const [hour, minute] of [
    [-1, 0],
    [24, 0],
    [12.5, 0],
    [0, -1],
    [0, 60],
    [0, 30.5],
  ]) {
    assert.throws(() => validateScheduleTime(hour, minute));
  }

  assert.doesNotThrow(() => validateScheduleTime(0, 0));
  assert.doesNotThrow(() => validateScheduleTime(23, 59));
});

test("nextSlotAtOrAfter handles before, exact, and after the target minute", () => {
  assertSlot(nextSlotAtOrAfter(new Date("2024-01-15T07:29:59.999Z"), 10, 30, "Europe/Moscow"), "2024-01-15T07:30:00.000Z", "2024-01-15", "Europe/Moscow");
  assertSlot(nextSlotAtOrAfter(new Date("2024-01-15T07:30:00.000Z"), 10, 30, "Europe/Moscow"), "2024-01-15T07:30:00.000Z", "2024-01-15", "Europe/Moscow");
  assertSlot(nextSlotAtOrAfter(new Date("2024-01-15T07:30:00.001Z"), 10, 30, "Europe/Moscow"), "2024-01-16T07:30:00.000Z", "2024-01-16", "Europe/Moscow");
});

test("strict-next and latest-slot helpers use opposite exact-boundary policies", () => {
  const exact = new Date("2024-01-15T07:30:00.000Z");

  assertSlot(nextSlotStrictlyAfter(exact, 10, 30, "Europe/Moscow"), "2024-01-16T07:30:00.000Z", "2024-01-16", "Europe/Moscow");
  assertSlot(latestSlotAtOrBefore(exact, 10, 30, "Europe/Moscow"), "2024-01-15T07:30:00.000Z", "2024-01-15", "Europe/Moscow");
  assertSlot(latestSlotAtOrBefore(new Date("2024-01-15T07:29:59.999Z"), 10, 30, "Europe/Moscow"), "2024-01-14T07:30:00.000Z", "2024-01-14", "Europe/Moscow");
});

test("slot helpers handle a local midnight boundary", () => {
  assertSlot(nextSlotAtOrAfter(new Date("2024-01-14T20:59:59.999Z"), 0, 0, "Europe/Moscow"), "2024-01-14T21:00:00.000Z", "2024-01-15", "Europe/Moscow");
});

test("resolveWallClock advances a spring gap to the first valid local minute", () => {
  const instant = resolveWallClock({ year: 2024, month: 3, day: 10 }, 2, 30, "America/New_York");
  assert.equal(instant.toISOString(), "2024-03-10T07:00:00.000Z");

  assertSlot(
    nextSlotAtOrAfter(
      new Date("2024-03-10T06:00:00.000Z"),
      2,
      30,
      "America/New_York",
    ),
    "2024-03-10T07:00:00.000Z",
    "2024-03-10",
    "America/New_York",
  );
});

test("resolveWallClock chooses the first occurrence in a fall overlap", () => {
  const instant = resolveWallClock({ year: 2024, month: 11, day: 3 }, 1, 30, "America/New_York");
  assert.equal(instant.toISOString(), "2024-11-03T05:30:00.000Z");

  assertSlot(
    latestSlotAtOrBefore(
      new Date("2024-11-03T06:15:00.000Z"),
      1,
      30,
      "America/New_York",
    ),
    "2024-11-03T05:30:00.000Z",
    "2024-11-03",
    "America/New_York",
  );
});

test("getCalendarDayRange returns 23-hour and 25-hour New York days", () => {
  const spring = getCalendarDayRange("America/New_York", new Date("2024-03-10T12:00:00.000Z"));
  assert.equal(spring.start.toISOString(), "2024-03-10T05:00:00.000Z");
  assert.equal(spring.end.toISOString(), "2024-03-11T04:00:00.000Z");
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 60 * 60 * 1000);

  const fall = getCalendarDayRange("America/New_York", new Date("2024-11-03T12:00:00.000Z"));
  assert.equal(fall.start.toISOString(), "2024-11-03T04:00:00.000Z");
  assert.equal(fall.end.toISOString(), "2024-11-04T05:00:00.000Z");
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 60 * 60 * 1000);
});

test("getCalendarDayRange handles a skipped local midnight", () => {
  const range = getCalendarDayRange("America/Santiago", new Date("2024-09-08T12:00:00.000Z"));
  assert.equal(range.start.toISOString(), "2024-09-08T04:00:00.000Z");
  assert.equal(range.end.toISOString(), "2024-09-09T03:00:00.000Z");
});

test("getLocalDateKey returns the date in the effective local timezone", () => {
  const instant = new Date("2024-01-15T22:30:00.000Z");
  assert.equal(getLocalDateKey(instant, "Europe/Moscow"), "2024-01-16");
  assert.equal(getLocalDateKey(instant, "America/New_York"), "2024-01-15");
});

test("time calculations produce identical UTC instants for different process TZ values", () => {
  const modulePath = require.resolve("../dist/shared/time/timezone");
  const script = `
    const time = require(${JSON.stringify(modulePath)});
    const result = {
      regular: time.nextSlotAtOrAfter(new Date("2024-01-15T07:29:59.999Z"), 10, 30, "Europe/Moscow").instant.toISOString(),
      gap: time.resolveWallClock({ year: 2024, month: 3, day: 10 }, 2, 30, "America/New_York").toISOString(),
      day: Object.fromEntries(Object.entries(time.getCalendarDayRange("America/New_York", new Date("2024-11-03T12:00:00.000Z"))).map(([key, value]) => [key, value.toISOString()])),
    };
    process.stdout.write(JSON.stringify(result));
  `;
  const runWithTimeZone = (timeZone) => JSON.parse(execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone },
  }));

  const utcResult = runWithTimeZone("UTC");
  const tokyoResult = runWithTimeZone("Asia/Tokyo");

  assert.deepEqual(tokyoResult, utcResult);
  assert.deepEqual(utcResult, {
    regular: "2024-01-15T07:30:00.000Z",
    gap: "2024-03-10T07:00:00.000Z",
    day: {
      start: "2024-11-03T04:00:00.000Z",
      end: "2024-11-04T05:00:00.000Z",
    },
  });
});
