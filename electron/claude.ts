import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExplainEvent, ExplainRequest } from "../shared/types";
import { SYSTEM_PROMPT, parseReply, userPrompt } from "./prompt";

/**
 * Runs explainers through the Claude Code CLI in headless mode, so they use
 * the user's Claude subscription rather than an API key.
 */

const COMMON_DIRS = [
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), ".claude/local"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

let claudePath: Promise<string> | undefined;

/** Apps launched from Finder don't get the shell's PATH, so look harder. */
export function findClaude(): Promise<string> {
  claudePath ??= new Promise((resolve, reject) => {
    for (const dir of COMMON_DIRS) {
      const candidate = path.join(dir, "claude");
      if (fs.existsSync(candidate)) return resolve(candidate);
    }
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(shell, ["-lic", "command -v claude"], { timeout: 10_000 }, (err, stdout) => {
      const found = stdout.trim().split("\n").pop();
      if (!err && found && fs.existsSync(found)) resolve(found);
      else reject(new Error("Couldn't find the claude CLI. Install Claude Code and sign in, then restart the app."));
    });
  });
  return claudePath;
}

const running = new Map<string, ChildProcess>();
const debug = (...args: unknown[]) => process.env.VR_DEBUG && console.log("[claude]", ...args);

export async function explain(
  req: ExplainRequest,
  workDir: string,
  emit: (event: ExplainEvent) => void,
): Promise<void> {
  let bin: string;
  try {
    bin = await findClaude();
  } catch (err) {
    emit({ id: req.id, type: "error", message: (err as Error).message });
    return;
  }

  const args = [
    "-p",
    userPrompt(req),
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt", SYSTEM_PROMPT,
    "--model", req.model,
    // A plain text-in, text-out call: no tools, no user/project settings, no MCP servers.
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
  ];
  if (req.sessionId) args.push("--resume", req.sessionId);

  // Without ANTHROPIC_API_KEY the CLI uses the signed-in subscription.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...COMMON_DIRS, process.env.PATH].join(":") };
  delete env.ANTHROPIC_API_KEY;

  fs.mkdirSync(workDir, { recursive: true });
  const child = spawn(bin, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
  debug("spawned", bin, "pid", child.pid, "model", req.model);
  running.set(req.id, child);

  let text = "";
  let sessionId = req.sessionId ?? "";
  let resultError: string | null = null;
  let stderr = "";
  let buffered = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type !== "stream_event") debug("event", msg.type, msg.subtype ?? "");
      const delta = msg.type === "stream_event" && msg.event?.type === "content_block_delta" ? msg.event.delta : null;
      if (delta?.type === "text_delta") {
        text += delta.text;
        emit({ id: req.id, type: "text", text });
      } else if (msg.type === "result") {
        if (msg.is_error || msg.subtype !== "success") resultError = String(msg.result ?? msg.subtype);
        else if (typeof msg.result === "string" && msg.result.length >= text.length) text = msg.result;
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  child.on("close", (code, signal) => {
    running.delete(req.id);
    debug("closed", code, signal, stderr.slice(-500));
    if (signal) return emit({ id: req.id, type: "error", message: "Stopped." });
    if (resultError || code !== 0) {
      const detail = resultError || stderr.trim().split("\n").slice(-3).join(" ") || `claude exited with code ${code}`;
      return emit({ id: req.id, type: "error", message: detail });
    }
    const { prose, html } = parseReply(text);
    emit({ id: req.id, type: "done", prose, html, sessionId });
  });
  child.on("error", (err) => {
    running.delete(req.id);
    emit({ id: req.id, type: "error", message: err.message });
  });
}

export function cancel(id: string) {
  running.get(id)?.kill("SIGTERM");
}

export function cancelAll() {
  for (const child of running.values()) child.kill("SIGTERM");
}
