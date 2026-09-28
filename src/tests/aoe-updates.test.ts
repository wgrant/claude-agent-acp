import { afterEach, describe, expect, it, vi } from "vitest";
import { clientWantsUpdate, OutputTokenMeter } from "../aoe-updates.js";

describe("aoe session updates", () => {
  afterEach(() => vi.useRealTimers());

  it("are sent only to a client that lists the kind", () => {
    const caps = { _meta: { "aoe/sessionUpdates": ["hook_update"] } };
    expect(clientWantsUpdate(caps, "hook_update")).toBe(true);
    expect(clientWantsUpdate(caps, "prompt_suggestion")).toBe(false);
    expect(clientWantsUpdate({}, "hook_update")).toBe(false);
  });

  it("meter a turn's output from estimates until each message is billed", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const meter = new OutputTokenMeter(async (tokens) => {
      sent.push(tokens);
    });
    const tick = () => vi.advanceTimersByTime(1000);

    meter.messageStarted();
    await meter.thought(30);
    tick();
    await meter.streamed("x".repeat(40));
    // Throttled until a second has passed.
    await meter.streamed("x".repeat(40));
    tick();
    await meter.billedOutput(55);
    tick();
    // Billed usage is cumulative, so a repeat replaces rather than adds.
    await meter.billedOutput(60);
    meter.messageStarted();
    tick();
    await meter.streamed("x".repeat(8));
    // Held back by the throttle when the turn ends, 62 is never sent.
    meter.turnEnded();
    tick();
    await meter.streamed("x".repeat(4));
    expect(sent).toEqual([30, 40, 50, 55, 60, 1]);
    // A count held back by the throttle still goes out once the window passes.
    await meter.streamed("x".repeat(40));
    expect(sent.at(-1)).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.at(-1)).toBe(11);
  });
});
