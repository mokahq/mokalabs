import { describe, expect, it } from "vitest";
import { decideFault, faultReply, seededRandom } from "../src/faults.js";

describe("faults", () => {
  it("are the same for the same seed, and respect tools and rate", () => {
    const faults = { seed: 7, rules: [{ tools: ["search"], rate: 0.5, fail: "error" as const }, { delayMs: [100, 200] as [number, number] }] };
    const roll = (seed: number) => {
      const random = seededRandom(seed);
      return Array.from({ length: 20 }, () => decideFault(faults, "search", random));
    };
    expect(roll(7)).toEqual(roll(7));
    const hits = roll(7).filter((d) => d?.fail === "error").length;
    expect(hits).toBeGreaterThan(3);
    expect(hits).toBeLessThan(17);
    for (const d of roll(7)) expect(d!.delayMs).toBeGreaterThanOrEqual(100), expect(d!.delayMs).toBeLessThanOrEqual(200);
    expect(decideFault(faults, "other", seededRandom(1))?.fail).toBeUndefined();
    expect(decideFault({ ...faults, enabled: false }, "search", seededRandom(1))).toBeUndefined();
  });

  it("replies like a server would, or not at all", () => {
    expect(faultReply("error", 3)).toMatchObject({ id: 3, error: { code: -32603 } });
    expect(faultReply("tool-error", 3)).toMatchObject({ result: { isError: true } });
    expect(faultReply("hang", 3)).toBeUndefined();
    expect(faultReply("crash", 3)).toBeUndefined();
  });
});
