import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { ForkTranscript } from "../fork-transcripts.js";

const msg = (uuid: string, final = false) =>
  ({
    uuid,
    type: "assistant",
    message: { content: final ? [{ type: "text", text: "done" }] : [{ type: "tool_use" }] },
  }) as unknown as SessionMessage;

describe("ForkTranscript", () => {
  it("delivers each message once while polling, and the rest when the fork finishes", async () => {
    vi.useFakeTimers();
    let transcript = [msg("a")];
    const delivered: string[] = [];
    const fork = new ForkTranscript(
      async () => transcript,
      async (m) => {
        delivered.push(m.uuid);
      },
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(delivered).toEqual(["a"]);
    transcript = [msg("a"), msg("b")];
    await vi.advanceTimersByTimeAsync(1500);
    expect(delivered).toEqual(["a", "b"]);
    // The final reply lands on disk only after the fork has ended.
    transcript = [msg("a"), msg("b"), msg("c")];
    const finished = fork.finish();
    await vi.advanceTimersByTimeAsync(250);
    transcript = [msg("a"), msg("b"), msg("c"), msg("d", true)];
    await vi.advanceTimersByTimeAsync(250);
    await finished;
    expect(delivered).toEqual(["a", "b", "c", "d"]);
    transcript = [msg("a"), msg("b"), msg("c"), msg("d", true), msg("e")];
    await vi.advanceTimersByTimeAsync(3000);
    expect(delivered).toEqual(["a", "b", "c", "d"]);
    vi.useRealTimers();
  });

  it("delivers nothing once cancelled, even from a read already in flight", async () => {
    vi.useFakeTimers();
    let release!: (messages: SessionMessage[]) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    const delivered: string[] = [];
    const fork = new ForkTranscript(
      () => {
        reading();
        return new Promise((resolve) => (release = resolve));
      },
      async (m) => {
        delivered.push(m.uuid);
      },
    );
    await vi.advanceTimersByTimeAsync(1500);
    await started;
    fork.cancel();
    release([msg("a"), msg("b", true)]);
    await fork.finish();
    expect(delivered).toEqual([]);
    vi.useRealTimers();
  });
});
