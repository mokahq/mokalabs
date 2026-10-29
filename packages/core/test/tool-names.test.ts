import { describe, expect, it } from "vitest";
import { repairToolName } from "../src/tool-names.js";

const tools = ["moka-demo__order_coffee", "moka-demo__get_time", "github__search", "jira__search", "render_ui"];

describe("repairToolName", () => {
  it("adds the missing server prefix when one tool fits", () => {
    expect(repairToolName("order_coffee", tools)).toBe("moka-demo__order_coffee");
    expect(repairToolName("render_ui", tools)).toBe("render_ui");
  });
  it("strips namespaces models invent", () => {
    expect(repairToolName("default_api__order_coffee", tools)).toBe("moka-demo__order_coffee");
    expect(repairToolName("default_api.get_time", tools)).toBe("moka-demo__get_time");
    expect(repairToolName("functions.moka-demo__get_time", tools)).toBe("moka-demo__get_time");
    expect(repairToolName("moka-demo.get_time", tools)).toBe("moka-demo__get_time");
  });
  it("leaves ambiguous and unknown names alone", () => {
    expect(repairToolName("search", tools)).toBeUndefined();
    expect(repairToolName("make_coffee", tools)).toBeUndefined();
  });
});
