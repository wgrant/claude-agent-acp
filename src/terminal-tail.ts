// Live output for Bash/PowerShell calls. The SDK reports no output while a
// command runs, but Claude Code writes each shell's output as it runs to
// `<tmp>/claude-<uid>/<project>/<session>/tasks/<task_id>.output`, deleting it
// when the command ends. Tailing that file lets the client show output live,
// as codex-acp does with `terminal_output_delta`. `tool_progress` names the
// task only in remote environments; otherwise a new task file is matched to a
// call only when that is unambiguous (see `discover`).

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
  forget(toolCallId);
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
  /** Absent for a call that may start a shell but is not tailed. */
  send?: (data: string) => Promise<void>;
  since: number;
}

interface SessionCalls {
  /** Shell calls waiting for their task file. */
  pending: PendingCall[];
  /** Task files never to attribute: older than a waiting call, or ambiguous. */
  known: Set<string>;
}

const sessions = new Map<string, SessionCalls>();
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

/** Stop matching `toolCallId`. A file not yet matched may be its own, so no other call gets one. */
function forget(toolCallId: string): void {
  for (const [sessionId, calls] of sessions) {
    const index = calls.pending.findIndex((call) => call.toolCallId === toolCallId);
    if (index < 0) continue;
    calls.pending.splice(index, 1);
    if (calls.pending.length === 0) {
      sessions.delete(sessionId);
    } else {
      for (const file of listShellTaskFiles(sessionId)) calls.known.add(file);
    }
    return;
  }
}

/**
 * Match a new task file to the call that created it. Task files do not name
 * their command, so a file is attributed only when exactly one call in its
 * session is waiting and exactly one new file appeared; anything else is
 * ambiguous and those files are never tailed.
 */
function discover(): void {
  const now = Date.now();
  for (const [sessionId, calls] of sessions) {
    for (const call of calls.pending.filter((call) => now - call.since > DISCOVERY_TIMEOUT_MS)) {
      forget(call.toolCallId);
    }
    if (!sessions.has(sessionId)) continue;
    const files = listShellTaskFiles(sessionId);
    const fresh = files.filter((file) => !calls.known.has(file) && !claimed.has(file));
    calls.known = new Set(files.filter((file) => calls.known.has(file)));
    if (fresh.length === 0) continue;
    const [call] = calls.pending;
    if (calls.pending.length === 1 && fresh.length === 1) {
      if (call.send) {
        startTerminalTail(call.toolCallId, fresh[0], call.send);
      } else {
        forget(call.toolCallId);
      }
    }
    for (const file of fresh) calls.known.add(file);
  }
  if (sessions.size === 0 && discovery) {
    clearInterval(discovery);
    discovery = undefined;
  }
}

/**
 * Tail the task file Claude Code creates for shell call `toolCallId`. Without
 * `send`, the call only marks that a shell may start, so it is not mistaken
 * for another call's.
 */
export function tailNextTaskOutput(
  toolCallId: string,
  sessionId: string,
  send?: (data: string) => Promise<void>,
): void {
  if (
    tails.has(toolCallId) ||
    [...sessions.values()].some((calls) =>
      calls.pending.some((call) => call.toolCallId === toolCallId),
    )
  ) {
    return;
  }
  let calls = sessions.get(sessionId);
  if (!calls) {
    calls = { pending: [], known: new Set() };
    sessions.set(sessionId, calls);
  }
  for (const file of listShellTaskFiles(sessionId)) calls.known.add(file);
  calls.pending.push({ toolCallId, send, since: Date.now() });
  discovery ??= setInterval(discover, POLL_MS);
}

function halt(toolCallId: string): void {
  forget(toolCallId);
  const tail = tails.get(toolCallId);
  if (tail) {
    clearInterval(tail.timer);
    claimed.delete(tail.file);
    for (const calls of sessions.values()) calls.known.add(tail.file);
    tails.delete(toolCallId);
  }
}

/** Stop tailing `toolCallId`; true when any of its output was streamed. */
export function stopTerminalTail(toolCallId: string): boolean {
  halt(toolCallId);
  return streamed.delete(toolCallId);
}

/** Stop every tail and pending match in `sessionId`, whose calls will get no result. */
export function stopSessionTails(sessionId: string): void {
  for (const call of [...(sessions.get(sessionId)?.pending ?? [])]) forget(call.toolCallId);
  for (const [toolCallId, tail] of tails) {
    if (path.basename(path.dirname(path.dirname(tail.file))) === sessionId) {
      halt(toolCallId);
      streamed.delete(toolCallId);
    }
  }
}
