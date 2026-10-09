import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleCompaction } from "../idle-compaction.js";

afterEach(() => vi.useRealTimers());

describe("idle compaction", () => {
  it("reports cache timing without enabling automatic compaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const compact = vi.fn().mockResolvedValue(undefined);
    const tracker = new IdleCompaction(Number.POSITIVE_INFINITY, compact, vi.fn());
    tracker.observe(
      {
        input_tokens: 100,
        cache_creation_input_tokens: 210_000,
        cache_creation: { ephemeral_1h_input_tokens: 210_000 },
      },
      1_000,
    );
    expect(tracker.snapshot?.expiresAt).toBe(3_699_000);
    tracker.arm();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(compact).not.toHaveBeenCalled();
  });
  it("uses request start, refreshes on hits, and compacts only once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const compact = vi.fn().mockResolvedValue(undefined);
    const tracker = new IdleCompaction(200_000, compact, vi.fn());
    tracker.observe(
      {
        input_tokens: 100,
        cache_creation_input_tokens: 210_000,
        cache_creation: { ephemeral_1h_input_tokens: 210_000 },
      },
      10_000,
    );
    expect(tracker.snapshot?.refreshedAt).toBe(90_000);
    tracker.observe({ input_tokens: 100, cache_read_input_tokens: 210_000 }, 1_000);
    tracker.arm();
    await vi.advanceTimersByTimeAsync(3_238_999);
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(compact).toHaveBeenCalledTimes(1);
    tracker.arm();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not guess timing or TTL, compact small contexts, or reuse invalidated state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    for (const [timing, tokens, writes, invalidate] of [
      [undefined, 210_000, true, false],
      [1_000, 210_000, false, false],
      [1_000, 100_000, true, false],
      [1_000, 210_000, true, true],
    ] as const) {
      const compact = vi.fn().mockResolvedValue(undefined);
      const tracker = new IdleCompaction(200_000, compact, vi.fn());
      tracker.observe(
        {
          input_tokens: 100,
          cache_creation_input_tokens: tokens,
          cache_creation: writes ? { ephemeral_1h_input_tokens: tokens } : undefined,
        },
        timing,
      );
      if (invalidate) tracker.invalidate();
      tracker.arm();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(compact).not.toHaveBeenCalled();
    }
  });

  it("abandons a late deadline and disarms for user activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const compact = vi.fn().mockResolvedValue(undefined);
    const tracker = new IdleCompaction(200_000, compact, vi.fn());
    tracker.observe(
      {
        input_tokens: 100,
        cache_creation_input_tokens: 210_000,
        cache_creation: { ephemeral_5m_input_tokens: 210_000 },
      },
      1_000,
    );
    tracker.arm();
    tracker.disarm();
    await vi.advanceTimersByTimeAsync(300_000);
    tracker.arm();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(compact).not.toHaveBeenCalled();
  });
});
