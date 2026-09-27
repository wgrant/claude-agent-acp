// Live output for Bash/PowerShell calls. The SDK's `tool_progress` beats carry
// only elapsed time, but Claude Code writes each shell's output as it runs to
// `<tmp>/claude-<uid>/<project>/<session>/tasks/<task_id>.output`, and the
// beats carry that task id. Tailing the file lets the client show output while
// the command runs, as codex-acp does with `terminal_output_delta`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 300;
/** A tick sends at most this much; a faster-growing file skips ahead. */
const MAX_READ = 256 * 1024;

interface Tail {
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
  let offset = 0;
  const decoder = new StringDecoder("utf8");
  const tail: Tail = {
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

function halt(toolCallId: string): void {
  const tail = tails.get(toolCallId);
  if (tail) {
    clearInterval(tail.timer);
    tails.delete(toolCallId);
  }
}

/** Stop tailing `toolCallId`; true when any of its output was streamed. */
export function stopTerminalTail(toolCallId: string): boolean {
  halt(toolCallId);
  return streamed.delete(toolCallId);
}
