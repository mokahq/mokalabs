import { describe, expect, it } from "vitest";
import { applyToolOverride, toolOverrideFor } from "../src/overrides.js";

const tool = {
  name: "get_time",
  description: "Get the time.",
  inputSchema: { type: "object", properties: { timezone: { type: "string", description: "Timezone" } }, required: ["timezone"] },
};

describe("tool overrides", () => {
  it("changes the wording, not the contract", () => {
    const shown = applyToolOverride(tool, {
      description: "Get the current time in an IANA timezone.",
      params: { timezone: { description: "IANA name, e.g. Asia/Tokyo", examples: ["Asia/Tokyo"] }, made_up: { description: "ignored" } },
    });
    expect(shown.description).toBe("Get the current time in an IANA timezone.");
    expect(shown.inputSchema).toEqual({
      type: "object",
      properties: { timezone: { type: "string", description: "IANA name, e.g. Asia/Tokyo", examples: ["Asia/Tokyo"] } },
      required: ["timezone"],
    });
    expect(shown.name).toBe("get_time");
    expect(tool.description).toBe("Get the time."); // the server's definition is untouched
  });

  it("prefers wording being tried over the saved one", () => {
    const server = { id: "demo", toolOverrides: { get_time: { description: "saved" } } };
    expect(toolOverrideFor(server, "get_time")?.description).toBe("saved");
    expect(toolOverrideFor(server, "get_time", { demo: { get_time: { description: "trying" } } })?.description).toBe("trying");
    expect(toolOverrideFor(server, "other")).toBeUndefined();
  });
});
