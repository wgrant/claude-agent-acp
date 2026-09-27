// Live output for Bash/PowerShell calls. The SDK reports no output while a
// command runs, but Claude Code writes each shell's output as it runs to
// `<tmp>/claude-<uid>/<project>/<session>/tasks/<task_id>.output`, deleting it
// when the command ends. Tailing that file lets the client show output live,
// as codex-acp does with `terminal_output_delta`. `tool_progress` names the
// task only in remote environments, so a call is otherwise matched to the
// next new task file in its session.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 300;
/** A tick sends at most this much; a faster-growing file skips ahead. */
const MAX_READ = 256 * 1024;

interface Tail {
  file: string;
  timer: ReturnType<typeof setInterval>;
  reading: boolean;
}

const tails = new Map<string, Tail>();
/** Calls whose output was streamed, until their result is sent. */
const streamed = new Set<string>();

function tmpRoots(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const bases = [process.env.CLAUDE_CODE_TMPDIR, os.tmpdir(), "/tmp"].filter(
    (b): b is string => !!b,
  );
  const names = uid === undefined ? ["claude"] : [`claude-${uid}`, "claude"];
  return [...new Set(bases.flatMap((base) => names.map((name) => path.join(base, name))))];
}

function sessionTaskDirs(sessionId: string): string[] {
  if (!/^[\w-]+$/.test(sessionId)) {
    return [];
  }
  return tmpRoots().flatMap((root) => {
    try {
      return fs
        .readdirSync(root)
        .map((project) => path.join(root, project, sessionId, "tasks"))
        .filter((dir) => fs.existsSync(dir));
    } catch {
      return [];
    }
  });
}

/** Where Claude Code writes the output of shell task `taskId` in `sessionId`. */
export function taskOutputPath(sessionId: string, taskId: string): string | undefined {
  if (!/^[\w-]+$/.test(taskId) || !/^[\w-]+$/.test(sessionId)) {
    return undefined;
  }
  for (const root of tmpRoots()) {
    let projects: string[];
    try {
      projects = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      const file = path.join(root, project, sessionId, "tasks", `${taskId}.output`);
      if (fs.existsSync(file)) {
        return file;
      }
    }
  }
  return undefined;
}

/** Start streaming `file` for tool call `toolCallId`; a second start is a no-op. */
export function startTerminalTail(
  toolCallId: string,
  file: string,
  send: (data: string) => Promise<void>,
): void {
  if (tails.has(toolCallId)) {
    return;
  }
  const waiting = pending.findIndex((call) => call.toolCallId === toolCallId);
  if (waiting >= 0) {
    pending.splice(waiting, 1);
  }
  claimed.add(file);
  let offset = 0;
  const decoder = new StringDecoder("utf8");
  const tail: Tail = {
    file,
    reading: false,
    timer: setInterval(() => {
      if (tail.reading) {
        return;
      }
      tail.reading = true;
      void (async () => {
        try {
          const handle = await fs.promises.open(file, "r");
          try {
            const { size } = await handle.stat();
            let skipped = 0;
            if (size - offset > MAX_READ) {
              skipped = size - MAX_READ - offset;
              offset = size - MAX_READ;
            }
            if (size <= offset) {
              return;
            }
            const buffer = Buffer.alloc(size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            offset += bytesRead;
            const text = decoder.write(buffer.subarray(0, bytesRead));
            if (!tails.has(toolCallId)) {
              return;
            }
            const note = skipped > 0 ? `\n[${skipped} bytes skipped]\n` : "";
            if (note || text) {
              streamed.add(toolCallId);
              await send(note + text);
            }
          } finally {
            await handle.close();
          }
        } catch {
          // Gone once the command ends; the tool result replaces the tail.
          halt(toolCallId);
        } finally {
          tail.reading = false;
        }
      })();
    }, POLL_MS),
  };
  tails.set(toolCallId, tail);
}

const SHELL_TASK_FILE = /^b[a-z0-9]+\.output$/;
/** Give up matching a call that never produced a task file. */
const DISCOVERY_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingCall {
  toolCallId: string;
  sessionId: string;
  send: (data: string) => Promise<void>;
  since: number;
  /** Task files that existed before the call started. */
  known: Set<string>;
}

/** Shell calls waiting for their task file, oldest first. */
const pending: PendingCall[] = [];
const claimed = new Set<string>();
let discovery: ReturnType<typeof setInterval> | undefined;

function listShellTaskFiles(sessionId: string): string[] {
  return sessionTaskDirs(sessionId).flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => SHELL_TASK_FILE.test(name))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  });
}

function birth(file: string): number {
  try {
    const stat = fs.statSync(file);
    return stat.birthtimeMs || stat.ctimeMs;
  } catch {
    return Infinity;
  }
}

/** Match new task files to waiting calls, both in the order they started. */
function discover(): void {
  const now = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].since > DISCOVERY_TIMEOUT_MS) {
      pending.splice(i, 1);
    }
  }
  for (const sessionId of new Set(pending.map((call) => call.sessionId))) {
    const calls = pending.filter((call) => call.sessionId === sessionId);
    const files = listShellTaskFiles(sessionId)
      .filter((file) => !claimed.has(file) && !calls[0].known.has(file))
      .sort((a, b) => birth(a) - birth(b));
    for (const [call, file] of calls.map((call, i) => [call, files[i]] as const)) {
      if (!file || call.known.has(file)) {
        break;
      }
      startTerminalTail(call.toolCallId, file, call.send);
    }
  }
  if (pending.length === 0 && discovery) {
    clearInterval(discovery);
    discovery = undefined;
  }
}

/** Tail the task file Claude Code creates for shell call `toolCallId`. */
export function tailNextTaskOutput(
  toolCallId: string,
  sessionId: string,
  send: (data: string) => Promise<void>,
): void {
  if (tails.has(toolCallId) || pending.some((call) => call.toolCallId === toolCallId)) {
    return;
  }
  pending.push({
    toolCallId,
    sessionId,
    send,
    since: Date.now(),
    known: new Set(listShellTaskFiles(sessionId)),
  });
  discovery ??= setInterval(discover, POLL_MS);
}

function halt(toolCallId: string): void {
  const waiting = pending.findIndex((call) => call.toolCallId === toolCallId);
  if (waiting >= 0) {
    pending.splice(waiting, 1);
  }
  const tail = tails.get(toolCallId);
  if (tail) {
    clearInterval(tail.timer);
    claimed.delete(tail.file);
    tails.delete(toolCallId);
  }
}

/** Stop tailing `toolCallId`; true when any of its output was streamed. */
export function stopTerminalTail(toolCallId: string): boolean {
  halt(toolCallId);
  return streamed.delete(toolCallId);
}
