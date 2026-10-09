export type CacheUsage = {
  input_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
};

export type CacheSnapshot = {
  refreshedAt: number;
  expiresAt: number;
  ttlMs: number;
  contextTokens: number;
};

/** Only schedules from timed requests with observed cache activity. */
export class IdleCompaction {
  snapshot?: CacheSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: { at: number; ttlMs?: number };
  private consumed = false;

  constructor(
    private readonly minimumTokens: number,
    private readonly compact: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  observe(usage: CacheUsage, ttftMs: number | undefined, now = Date.now()): void {
    this.disarm();
    this.snapshot = undefined;
    this.consumed = false;
    if (ttftMs === undefined || !Number.isFinite(ttftMs) || ttftMs < 0) {
      this.request = undefined;
      return;
    }
    const writes = usage.cache_creation;
    const ttlMs =
      (writes?.ephemeral_5m_input_tokens ?? 0) > 0
        ? 300_000
        : (writes?.ephemeral_1h_input_tokens ?? 0) > 0
          ? 3_600_000
          : this.request?.ttlMs;
    this.request = { at: now - ttftMs, ttlMs };
    if (ttlMs === undefined) return;
    const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (cached <= 0) return;
    this.snapshot = {
      refreshedAt: this.request.at,
      expiresAt: this.request.at + ttlMs,
      ttlMs,
      contextTokens: usage.input_tokens + cached,
    };
  }

  arm(now = Date.now()): void {
    this.disarm();
    const cache = this.snapshot;
    if (this.consumed || !cache || cache.contextTokens < this.minimumTokens) return;
    const deadline = cache.refreshedAt + cache.ttlMs * 0.9;
    // A delayed/long-running turn must not compact against a nearly cold cache.
    if (deadline <= now) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.consumed = true;
      if (Date.now() >= cache.expiresAt - Math.min(60_000, cache.ttlMs * 0.05)) return;
      void this.compact().catch(this.onError);
    }, deadline - now);
    this.timer.unref?.();
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {
    this.disarm();
    this.request = undefined;
    this.snapshot = undefined;
  }
}
