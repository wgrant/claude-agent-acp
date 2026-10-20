import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkflowWatcher, workflowSource, type WorkflowAgent } from "../workflow-agents.js";

const sdk = vi.hoisted(() => ({ list: vi.fn(), messages: vi.fn(), find: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSubagents: sdk.list,
  getSubagentMessages: sdk.messages,
}));
vi.mock("../resumed-session.js", () => ({ findTranscript: sdk.find }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const msg = (uuid: string, text = uuid, type = "assistant") =>
  ({ uuid, type, message: { content: [{ type: "text", text }] } }) as SessionMessage;

it("discovers each child once, retries delivery at its offset, and finishes all open agents", async () => {
  vi.useFakeTimers();
  let agents: WorkflowAgent[] = [{ id: "a", label: "batch-1", phase: "Classify", model: "haiku" }];
  const messages = new Map([["a", [msg("prompt", "Check tests", "user"), msg("a1")]]]);
  const spawn = vi.fn(async (_agent: WorkflowAgent, _prompt?: string) => true);
  const message = vi.fn(async (_agent: WorkflowAgent, _message: SessionMessage) => {});
  const finish = vi.fn(async (_agent: WorkflowAgent, _state: string) => {});
  const read = vi.fn(async (id: string, offset: number) => (messages.get(id) ?? []).slice(offset));
  const watcher = new WorkflowWatcher(
    { agents: async () => agents, messages: read },
    { spawn, message, finish },
  );
  try {
    await watcher.poll();
    expect(spawn).toHaveBeenCalledWith(agents[0], "Check tests");
    messages.get("a")!.push(msg("a2"));
    message.mockRejectedValueOnce(new Error("retry"));
    await watcher.poll();
    await watcher.poll();
    expect(read).toHaveBeenCalledWith("a", 2);
    expect(message.mock.calls.map((args) => args[1].uuid)).toEqual(["prompt", "a1", "a2", "a2"]);
    agents = [{ ...agents[0]!, result: "classified" }, { id: "b" }];
    messages.set("b", [msg("bp", "Fallback label\nMore instructions", "user")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]![0].label).toBe("Fallback label");
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", result: "classified" }),
      "completed",
    );
    await watcher.finish("cancelled");
    expect(finish.mock.calls.map((args) => [args[0].id, args[1]])).toEqual([
      ["a", "completed"],
      ["b", "cancelled"],
    ]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(finish).toHaveBeenCalledTimes(2);
  } finally {
    watcher.cancel();
  }
});

it("cancels an in-flight read without announcing or delivering late children", async () => {
  const pending = Promise.withResolvers<WorkflowAgent[]>();
  const callbacks = {
    spawn: vi.fn(async () => true),
    message: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  };
  const watcher = new WorkflowWatcher(
    { agents: () => pending.promise, messages: async () => [] },
    callbacks,
  );
  const poll = watcher.poll();
  watcher.cancel();
  pending.resolve([{ id: "late" }]);
  await poll;
  expect(callbacks.spawn).not.toHaveBeenCalled();
});

it("scopes SDK agents to the tool's run directory and tolerates missing or damaged optional metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-agents-"));
  try {
    sdk.find.mockResolvedValue(path.join(root, "session.jsonl"));
    const directory = path.join(root, "session", "subagents", "workflows", "wf-1");
    await mkdir(directory, { recursive: true });
    for (const id of ["a", "b", "c"])
      await writeFile(path.join(directory, `agent-${id}.jsonl`), "");
    await writeFile(
      path.join(directory, "agent-a.meta.json"),
      JSON.stringify({ description: "batch-1", workflowPhase: "Classify", model: "haiku" }),
    );
    await writeFile(path.join(directory, "agent-b.meta.json"), "broken");
    await writeFile(
      path.join(directory, "journal.jsonl"),
      JSON.stringify({ type: "result", agentId: "a", result: { ok: true } }) + "\n{partial",
    );
    sdk.list.mockResolvedValue(["a", "b", "c", "unrelated"]);
    sdk.messages.mockResolvedValue([msg("one")]);
    const source = await workflowSource("session", "/project", directory);
    expect(await source!.agents()).toEqual([
      { id: "a", label: "batch-1", phase: "Classify", model: "haiku", result: '{"ok":true}' },
      { id: "b", label: undefined, phase: undefined, model: undefined },
      { id: "c", label: undefined, phase: undefined, model: undefined },
    ]);
    await source!.messages("a", 17);
    expect(sdk.messages).toHaveBeenCalledWith("session", "a", {
      dir: "/project",
      offset: 17,
      limit: 100,
    });
    expect(await workflowSource("session", "/project", root)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
