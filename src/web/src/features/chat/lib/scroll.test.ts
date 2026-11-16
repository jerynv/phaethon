import { describe, expect, test } from "vitest";
import { distanceFromEnd, FIRST_MESSAGES, firstMounted, heldIndex, holdTop, MOUNT_ALL_BELOW, mountedAll, pinAfterScroll, REPIN_PX, STEP_MESSAGES, travel, widen } from "./scroll.ts";

const view = (scrollTop: number, scrollHeight = 5000, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight });

describe("the pin", () => {
  test("measures the distance from the end, never below zero", () => {
    expect(distanceFromEnd(view(4200))).toBe(0);
    expect(distanceFromEnd(view(4300))).toBe(0);
    expect(distanceFromEnd(view(4000))).toBe(200);
  });

  test("lets go when the reader scrolls up", () => {
    expect(pinAfterScroll(true, { scrollTop: 4200, scrollHeight: 5000 }, view(4100))).toBe(false);
  });

  test("holds when content shrinking clamps the position (the height changed, the reader did nothing)", () => {
    expect(pinAfterScroll(true, { scrollTop: 4200, scrollHeight: 5000 }, view(4100, 4900))).toBe(true);
  });

  test("pins at the end, and when the reader scrolls down to near it", () => {
    expect(pinAfterScroll(false, { scrollTop: 3000, scrollHeight: 5000 }, view(4199))).toBe(true);
    expect(pinAfterScroll(false, { scrollTop: 3000, scrollHeight: 5000 }, view(4200 - REPIN_PX + 1))).toBe(true);
    expect(pinAfterScroll(false, { scrollTop: 3000, scrollHeight: 5000 }, view(3500))).toBe(false);
  });

  test("does not pin again while the reader is moving up, even near the end", () => {
    expect(pinAfterScroll(false, { scrollTop: 4190, scrollHeight: 5000 }, view(4180))).toBe(false);
  });
});

describe("travel", () => {
  test("glides a short way and jumps a long one", () => {
    expect(travel(600, 800, false)).toBe("smooth");
    expect(travel(-1100, 800, false)).toBe("smooth");
    expect(travel(5000, 800, false)).toBe("instant");
  });

  test("never glides under reduced motion or without a view", () => {
    expect(travel(100, 800, true)).toBe("instant");
    expect(travel(100, 0, false)).toBe("instant");
  });
});

describe("holding a message", () => {
  test("moves the view by however far the message moved", () => {
    // The message was held 40 px below the top; content above grew, and it is now 260 px below.
    expect(holdTop(1000, 260, 40, { scrollHeight: 5000, clientHeight: 800 })).toBe(1220);
    expect(holdTop(1000, -60, 40, { scrollHeight: 5000, clientHeight: 800 })).toBe(900);
  });

  test("compares positions as painted, on whole pixels", () => {
    expect(holdTop(1000, 40.4, 40, { scrollHeight: 5000, clientHeight: 800 })).toBe(1000);
    expect(holdTop(1000, 39.6, 40, { scrollHeight: 5000, clientHeight: 800 })).toBe(1000);
    // Held at 40.3 (painted at 40); now at 2040.7 (painted at 2041): 2001 px, not 2000.4 rounded.
    expect(holdTop(1000, 2040.7, 40.3, { scrollHeight: 9000, clientHeight: 800 })).toBe(3001);
  });

  test("stays inside the scrollable range", () => {
    expect(holdTop(4100, 900, 0, { scrollHeight: 5000, clientHeight: 800 })).toBe(4200);
    expect(holdTop(10, -500, 0, { scrollHeight: 5000, clientHeight: 800 })).toBe(0);
  });

  test("finds the first message still on screen at the top", () => {
    const bottoms = [-300, -120, -1, 0, 40, 500, 900];
    expect(heldIndex(bottoms.length, (i) => bottoms[i]!)).toBe(4);
    expect(heldIndex(3, () => 10)).toBe(0);
    expect(heldIndex(3, () => -10)).toBe(2);
    expect(heldIndex(0, () => 0)).toBe(-1);
  });
});

describe("mounting a long conversation", () => {
  test("mounts a short one whole", () => {
    expect(firstMounted(MOUNT_ALL_BELOW - 1)).toEqual({ from: 0, to: null });
  });

  test("starts a long one at its newest messages", () => {
    expect(firstMounted(600)).toEqual({ from: 600 - FIRST_MESSAGES, to: null });
  });

  test("starts around the message it was left at, not everything after it", () => {
    expect(firstMounted(600, 300)).toEqual({ from: 292, to: 292 + FIRST_MESSAGES });
    expect(firstMounted(600, 3)).toEqual({ from: 0, to: FIRST_MESSAGES });
    // Near the end: the newest window already holds it.
    expect(firstMounted(600, 590)).toEqual({ from: 600 - FIRST_MESSAGES, to: null });
  });

  test("widens both ways a step at a time until it holds every message", () => {
    expect(widen({ from: 500, to: null }, 600)).toEqual({ from: 500 - STEP_MESSAGES, to: null });
    expect(widen({ from: 10, to: 100 }, 600)).toEqual({ from: 0, to: 100 + STEP_MESSAGES });
    expect(widen({ from: 0, to: 590 }, 600)).toEqual({ from: 0, to: null });
    for (const start of [firstMounted(600), firstMounted(600, 300), firstMounted(600, 0)]) {
      let m = start;
      let steps = 0;
      while (!mountedAll(m)) {
        m = widen(m, 600);
        steps++;
      }
      expect(steps).toBeLessThanOrEqual(Math.ceil(600 / STEP_MESSAGES));
    }
  });
});
