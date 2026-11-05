import { describe, expect, it } from "vitest";
import { forkFromStep, forkWithArguments, forkWithReply, forkWithResult, partSteps, switchBranch, turnRange } from "../web/src/timetravel";
import type { UiMessage } from "../web/src/types";

// One turn in two steps: think + call get_time (and roll_dice), then the answer.
const turn = [
  { role: "assistant", content: [{ type: "reasoning", text: "Need the time." }, { type: "tool-call", toolCallId: "c1", toolName: "demo__get_time", input: { timezone: "Tokyo" } }, { type: "tool-call", toolCallId: "c2", toolName: "demo__roll_dice", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "demo__get_time", output: { type: "text", value: "10:00" } }, { type: "tool-result", toolCallId: "c2", toolName: "demo__roll_dice", output: { type: "text", value: "4" } }] },
  { role: "assistant", content: [{ type: "text", text: "It's 10:00." }] },
];
const reply: UiMessage = {
  id: "a1",
  role: "assistant",
  meta: { runId: "run1" },
  parts: [
    { type: "reasoning", text: "Need the time." },
    { type: "tool", id: "c1", name: "demo__get_time", tool: "get_time", source: "Demo", input: { timezone: "Tokyo" }, output: "10:00", status: "done" },
    { type: "tool", id: "c2", name: "demo__roll_dice", tool: "roll_dice", source: "Demo", input: {}, output: "4", status: "done" },
    { type: "text", text: "It's 10:00." },
  ],
};
const user = (id: string, text: string): UiMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const messages = [user("u1", "time?"), reply, user("u2", "thanks"), { id: "a2", role: "assistant", parts: [{ type: "text", text: "You're welcome" }] } as UiMessage];
const model = [{ role: "user", content: "time?" }, ...turn, { role: "user", content: "thanks" }, { role: "assistant", content: [{ type: "text", text: "You're welcome" }] }];

describe("time-travel", () => {
  it("maps a reply's parts to its turn's steps", () => {
    expect(turnRange(messages, model, 1)).toEqual([1, 4]);
    expect(turnRange(messages, model, 3)).toEqual([5, 6]);
    expect(partSteps(reply.parts, turn)).toEqual([0, 0, 0, 1]);
  });

  it("forks with an edited result: same calls, new output, nothing runs again", () => {
    const plan = forkWithResult(reply, turn, "c1", "API down", true);
    expect(plan.prefix).toHaveLength(2);
    expect((plan.prefix[1] as any).content[0].output).toEqual({ type: "error-text", value: "API down" });
    expect((plan.prefix[1] as any).content[1].output.value).toBe("4");
    expect(plan.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "tool"]);
    expect(plan.parts[1]).toMatchObject({ edited: "result", isError: true, output: "API down" });
    expect(plan.fork).toMatchObject({ step: 1, edit: "result", tool: "get_time", runId: "run1" });
  });

  it("forks with edited arguments: the call runs again, the other results stay", () => {
    const plan = forkWithArguments(reply, turn, "c1", { timezone: "Asia/Tokyo" });
    expect((plan.prefix[0] as any).content[1].input).toEqual({ timezone: "Asia/Tokyo" });
    expect((plan.prefix[1] as any).content.map((p: any) => p.toolCallId)).toEqual(["c2"]);
    expect(plan.parts.map((p) => (p.type === "tool" ? p.id : p.type))).toEqual(["reasoning", "c2"]);
  });

  it("forks with an edited reply: a final answer is the branch itself; thinking is never edited", () => {
    const plan = forkWithReply(reply, turn, 3, "It's ten.");
    expect(plan.done).toBe(true);
    expect((plan.prefix.at(-1) as any).content).toEqual([{ type: "text", text: "It's ten." }]);
    expect(plan.parts.at(-1)).toEqual({ type: "text", text: "It's ten.", edited: true });
    expect(plan.parts.filter((p) => p.type === "tool")).toHaveLength(2);
  });

  it("forks from a step with another model, or retries it", () => {
    const answer = forkFromStep(reply, turn, 3, { id: "b", label: "gpt-5-mini" });
    expect(answer.prefix).toHaveLength(2);
    expect(answer.fork).toMatchObject({ step: 2, edit: "model", label: "gpt-5-mini from step 2" });
    const whole = forkFromStep(reply, turn, 1);
    expect(whole.prefix).toEqual([]);
    expect(whole.parts).toEqual([]);
  });

  it("switches branches and keeps the conversation after each", () => {
    // Make a branch 2 (an edited answer with no follow-up), then flip back and forth.
    const plan = forkWithReply(reply, turn, 3, "It's ten.");
    const branched = switchBranch(messages, model, 1, 0);
    const withFork = {
      messages: [...branched.messages.slice(0, 1), { id: "a1b", role: "assistant" as const, parts: plan.parts, fork: plan.fork, branches: [...branched.messages[1]!.branches!, { label: plan.fork.label, fork: plan.fork, message: { id: "a1b", role: "assistant" as const, parts: plan.parts }, turnModel: plan.prefix, tail: [], tailModel: [] }], branch: 1 }],
      modelMessages: [model[0], ...plan.prefix],
    };
    const back = switchBranch(withFork.messages, withFork.modelMessages, 1, 0);
    expect(back.messages).toHaveLength(4);
    expect(back.messages[3]!.parts[0]).toEqual({ type: "text", text: "You're welcome" });
    expect(back.modelMessages).toEqual(model);
    const again = switchBranch(back.messages, back.modelMessages, 1, 1);
    expect(again.messages).toHaveLength(2);
    expect(again.messages[1]!.parts.at(-1)).toMatchObject({ text: "It's ten.", edited: true });
    expect(again.messages[1]!.branch).toBe(1);
    expect(again.modelMessages).toEqual([model[0], ...plan.prefix]);
  });
});
