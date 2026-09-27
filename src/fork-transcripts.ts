// A forked skill (`context: fork`) runs as a subagent whose transcript the SDK
// deliberately withholds (`task_started.skip_transcript`), so its work never
// streams. The SDK does expose the transcript through `getSubagentMessages`;
// polling that while the fork runs lets its native subagent session fill in
// live, as the CLI's agent view does.

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

const POLL_MS = 1500;
/** The fork's final reply can reach its transcript just after the task ends. */
const SETTLE_MS = 250;
const SETTLE_LIMIT_MS = 2000;

/** Assistant text calling no tools is the fork's final reply. */
function isFinalReply(message: SessionMessage): boolean {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return (
    message.type === "assistant" &&
    Array.isArray(content) &&
    content.some((block) => block?.type === "text") &&
    !content.some((block) => block?.type === "tool_use")
  );
}

export class ForkTranscript {
  private readonly seen = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling: Promise<void> | undefined;
  private finished = false;
  private cancelled = false;
  private ended = false;

  constructor(
    private readonly read: () => Promise<SessionMessage[]>,
    private readonly deliver: (message: SessionMessage) => Promise<void>,
  ) {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        for (const message of await this.read()) {
          if (this.cancelled) return;
          if (this.seen.has(message.uuid)) continue;
          this.seen.add(message.uuid);
          this.ended = isFinalReply(message);
          await this.deliver(message);
        }
      } catch {
        // A transcript not written yet reads as empty; the next poll retries.
      } finally {
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  /**
   * Deliver the rest of the transcript, then stop; a repeat call waits for a
   * running poll. Only a completed fork has a final reply worth waiting for.
   */
  async finish(completed: boolean): Promise<void> {
    clearInterval(this.timer);
    if (this.finished) return this.polling;
    this.finished = true;
    await this.polling;
    for (let waited = 0; ; waited += SETTLE_MS) {
      await this.poll();
      if (!completed || this.ended || this.cancelled || waited >= SETTLE_LIMIT_MS) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    }
  }

  /** Stop, delivering nothing more, even from a poll already running. */
  cancel(): void {
    clearInterval(this.timer);
    this.finished = true;
    this.cancelled = true;
  }
}
