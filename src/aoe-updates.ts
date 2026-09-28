// Claude Code state the ACP schema has no place for, sent as extra session
// update kinds to a client that lists them in
// `clientCapabilities._meta["aoe/sessionUpdates"]`.

import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";

export type AoeUpdateKind =
  "hook_update" | "prompt_suggestion" | "tool_use_summary" | "turn_output_tokens";

export function clientWantsUpdate(
  capabilities: ClientCapabilities | null | undefined,
  kind: AoeUpdateKind,
): boolean {
  const kinds = capabilities?._meta?.["aoe/sessionUpdates"];
  return Array.isArray(kinds) && kinds.includes(kind);
}

/** A client that renders Claude Code's ReportFindings, so code reviews report through it. */
export function clientRendersFindings(
  capabilities: ClientCapabilities | null | undefined,
): boolean {
  return capabilities?._meta?.["aoe/reportFindings"] === true;
}

export function aoeUpdate(
  kind: AoeUpdateKind,
  fields: Record<string, unknown>,
): SessionNotification["update"] {
  return { sessionUpdate: kind, ...fields } as unknown as SessionNotification["update"];
}

/** A turn's output tokens at most this often; the CLI's spinner is no finer. */
const TOKEN_UPDATE_MS = 1000;

/**
 * The CLI spinner's "↓ N tokens": each message's billed output once its usage
 * arrives, and until then an estimate from its streamed text and tool input
 * (about four characters a token) plus Claude Code's thinking estimate.
 */
export class OutputTokenMeter {
  private earlier = 0;
  private billed: number | undefined;
  private chars = 0;
  private thinking = 0;
  private sent = 0;
  private sentAt = 0;
  /** Sends the count a throttled update held back, so it never goes stale. */
  private trailing: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly send: (tokens: number) => Promise<void>) {}

  messageStarted(): void {
    this.earlier += this.current();
    this.billed = undefined;
    this.chars = 0;
    this.thinking = 0;
  }

  streamed(text: string): Promise<void> {
    this.chars += text.length;
    return this.report();
  }

  thought(tokensDelta: number): Promise<void> {
    this.thinking += tokensDelta;
    return this.report();
  }

  /** `outputTokens` is the message's cumulative usage so far. */
  billedOutput(outputTokens: number): Promise<void> {
    this.billed = outputTokens;
    return this.report();
  }

  turnEnded(): void {
    this.earlier = 0;
    this.billed = undefined;
    this.chars = 0;
    this.thinking = 0;
    this.sent = 0;
    this.sentAt = 0;
    clearTimeout(this.trailing);
    this.trailing = undefined;
  }

  private current(): number {
    return this.billed ?? Math.ceil(this.chars / 4) + this.thinking;
  }

  private async report(): Promise<void> {
    const tokens = this.earlier + this.current();
    if (tokens === this.sent) return;
    const wait = this.sentAt + TOKEN_UPDATE_MS - Date.now();
    if (wait > 0) {
      this.trailing ??= setTimeout(() => {
        this.trailing = undefined;
        void this.report().catch(() => {});
      }, wait);
      return;
    }
    this.sent = tokens;
    this.sentAt = Date.now();
    await this.send(tokens);
  }
}
