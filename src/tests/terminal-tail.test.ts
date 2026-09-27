import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startTerminalTail,
  stopTerminalTail,
  tailNextTaskOutput,
  taskOutputPath,
} from "../terminal-tail.js";

describe("terminal tail", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a task's output file and streams what is appended to it", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
    dirs.push(base);
    vi.stubEnv("CLAUDE_CODE_TMPDIR", base);
    const uid = process.getuid?.();
    const tasks = path.join(
      base,
      uid === undefined ? "claude" : `claude-${uid}`,
      "-proj",
      "sess-1",
      "tasks",
    );
    fs.mkdirSync(tasks, { recursive: true });
    const file = path.join(tasks, "b123.output");
    fs.writeFileSync(file, "one\n");

    expect(taskOutputPath("sess-1", "b123")).toBe(file);
    expect(taskOutputPath("sess-1", "../escape")).toBeUndefined();

    const sent: string[] = [];
    startTerminalTail("tool-1", file, async (data) => {
      sent.push(data);
    });
    await vi.waitFor(() => expect(sent.join("")).toBe("one\n"));
    fs.appendFileSync(file, "two\n");
    await vi.waitFor(() => expect(sent.join("")).toBe("one\ntwo\n"));

    expect(stopTerminalTail("tool-1")).toBe(true);
    expect(stopTerminalTail("tool-1")).toBe(false);
  });

  it("matches a call to the next task file created in its session", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
    dirs.push(base);
    vi.stubEnv("CLAUDE_CODE_TMPDIR", base);
    const uid = process.getuid?.();
    const tasks = path.join(
      base,
      uid === undefined ? "claude" : `claude-${uid}`,
      "-proj",
      "sess-2",
      "tasks",
    );
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, "bold.output"), "earlier command\n");

    const sent: string[] = [];
    tailNextTaskOutput("tool-2", "sess-2", async (data) => {
      sent.push(data);
    });
    fs.writeFileSync(path.join(tasks, "a1.output"), "an agent, not a shell\n");
    fs.writeFileSync(path.join(tasks, "bnew.output"), "tick 1\n");
    await vi.waitFor(() => expect(sent.join("")).toBe("tick 1\n"));
    expect(stopTerminalTail("tool-2")).toBe(true);
  });
});
