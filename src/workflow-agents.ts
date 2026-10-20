import {
  listSubagents,
  getSubagentMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { findTranscript } from "./resumed-session.js";

export interface WorkflowAgent {
  id: string;
  label?: string;
  phase?: string;
  model?: string;
  result?: string;
}

export interface WorkflowSource {
  agents(): Promise<WorkflowAgent[]>;
  messages(id: string, offset: number): Promise<SessionMessage[]>;
}

/** Only a Workflow tool result can bind a task to a transcript directory. */
export async function workflowSource(
  sessionId: string,
  cwd: string,
  directory: string,
): Promise<WorkflowSource | undefined> {
  const transcript = await findTranscript(sessionId);
  if (!transcript) return undefined;
  const root = path.join(path.dirname(transcript), sessionId, "subagents", "workflows");
  try {
    const resolvedRoot = await realpath(root);
    const resolved = await realpath(directory);
    if (path.dirname(resolved) !== resolvedRoot) return undefined;
    directory = resolved;
  } catch {
    return undefined;
  }
  return {
    async agents() {
      const [ids, files] = await Promise.all([
        listSubagents(sessionId, { dir: cwd }),
        readdir(directory),
      ]);
      const records = new Map<string, WorkflowAgent>();
      for (const file of files) {
        const id = /^agent-([^/]+)\.jsonl$/.exec(file)?.[1];
        if (!id || !ids.includes(id)) continue;
        let meta: Record<string, unknown> = {};
        try {
          meta =
            JSON.parse(await readFile(path.join(directory, `agent-${id}.meta.json`), "utf8")) ?? {};
        } catch {
          /* Optional CLI metadata. */
        }
        records.set(id, {
          id,
          label: typeof meta.description === "string" ? meta.description : undefined,
          phase: typeof meta.workflowPhase === "string" ? meta.workflowPhase : undefined,
          model: typeof meta.model === "string" ? meta.model : undefined,
        });
      }
      try {
        for (const line of (await readFile(path.join(directory, "journal.jsonl"), "utf8")).split(
          "\n",
        )) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const agent =
              typeof entry.agentId === "string" ? records.get(entry.agentId) : undefined;
            if (!agent) continue;
            if (entry.type === "started") {
              agent.label ??= typeof entry.label === "string" ? entry.label : undefined;
              agent.phase ??= typeof entry.phase === "string" ? entry.phase : undefined;
            } else if (entry.type === "result") {
              agent.result =
                (typeof entry.result === "string"
                  ? entry.result
                  : JSON.stringify(entry.result)
                )?.slice(0, 1000) ?? "Completed";
            }
          } catch {
            /* A partial journal line is retried on the next poll. */
          }
        }
      } catch {
        /* Public transcript reads still work without the journal. */
      }
      return [...records.values()];
    },
    messages: (id, offset) => getSubagentMessages(sessionId, id, { dir: cwd, offset, limit: 100 }),
  };
}

interface Child {
  agent: WorkflowAgent;
  offset: number;
  seen: Set<string>;
  ended: boolean;
  finalReply: boolean;
}

export class WorkflowWatcher {
  private readonly children = new Map<string, Child>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly source: WorkflowSource,
    private readonly callbacks: {
      spawn(agent: WorkflowAgent, prompt?: string): Promise<boolean>;
      message(agent: WorkflowAgent, message: SessionMessage): Promise<void>;
      finish(
        agent: WorkflowAgent,
        state: "completed" | "failed" | "cancelled" | "disconnected",
      ): Promise<void>;
    },
  ) {
    this.timer = setInterval(() => void this.poll(), 5000);
    this.timer.unref();
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.polling ??= this.read()
      .catch(() => {})
      .finally(() => {
        this.polling = undefined;
      }));
  }

  private async read(): Promise<void> {
    for (const agent of await this.source.agents()) {
      if (this.stopped) return;
      let child = this.children.get(agent.id);
      let initial: SessionMessage[] | undefined;
      if (!child) {
        const first = await this.source.messages(agent.id, 0);
        initial = first;
        if (this.stopped) return;
        const prompt = first.find((message) => message.type === "user");
        const text = messageText(prompt);
        agent.label ||= text?.split("\n")[0]?.slice(0, 160) || "Workflow agent";
        const model = first.find((message) => message.type === "assistant")?.message as
          { model?: unknown } | undefined;
        agent.model ??= typeof model?.model === "string" ? model.model : undefined;
        if (!(await this.callbacks.spawn(agent, text))) continue;
        child = { agent, offset: 0, seen: new Set(), ended: false, finalReply: false };
        this.children.set(agent.id, child);
      }
      if (child.ended) continue;
      child.agent.result = agent.result;
      let messages: SessionMessage[];
      do {
        messages = initial ?? (await this.source.messages(agent.id, child.offset));
        initial = undefined;
        for (const message of messages) {
          if (this.stopped) return;
          if (!child.seen.has(message.uuid)) {
            await this.callbacks.message(child.agent, message);
            const content = (message.message as { content?: unknown })?.content;
            child.finalReply =
              message.type === "assistant" &&
              (typeof content === "string"
                ? content.trim().length > 0
                : Array.isArray(content) &&
                  content.some((block) => block?.type === "text") &&
                  !content.some((block) =>
                    ["tool_use", "server_tool_use", "mcp_tool_use"].includes(block?.type),
                  ));
            child.seen.add(message.uuid);
            if (child.seen.size > 2048) child.seen.delete(child.seen.values().next().value!);
          }
          child.offset++;
        }
      } while (messages.length === 100 && !this.stopped);
      if (this.stopped) return;
      if (agent.result !== undefined) {
        await this.callbacks.finish(child.agent, "completed");
        child.ended = true;
      }
    }
  }

  async finish(state: "completed" | "failed" | "cancelled" | "disconnected"): Promise<void> {
    clearInterval(this.timer);
    await this.polling;
    await this.poll();
    this.stopped = true;
    for (const child of this.children.values()) {
      if (!child.ended) {
        await this.callbacks.finish(
          child.agent,
          state === "completed" && !child.finalReply ? "disconnected" : state,
        );
        child.ended = true;
      }
    }
  }

  async cancel(): Promise<void> {
    clearInterval(this.timer);
    this.stopped = true;
    await this.polling;
  }
}

function messageText(message: SessionMessage | undefined): string | undefined {
  const content = (message?.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return (
    content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n") || undefined
  );
}
