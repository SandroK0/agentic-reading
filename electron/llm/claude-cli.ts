import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abortError, type ChatMessage, type ChatRequest, type ChatResult, type LlmProvider } from "./provider";

/**
 * Reaches Claude through the Claude Code CLI in headless mode (`claude -p`),
 * so requests run on the user's signed-in Claude subscription rather than an
 * API key. Conversations resume from the CLI's session id.
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

const debug = (...args: unknown[]) => process.env.VR_DEBUG && console.log("[claude-cli]", ...args);

export class ClaudeCliProvider implements LlmProvider {
  readonly id = "claude-cli";
  readonly label = "Claude (Claude Code)";
  readonly models = [
    { id: "sonnet", label: "Sonnet (faster)" },
    { id: "opus", label: "Opus (best)" },
    { id: "haiku", label: "Haiku (fastest)" },
    { id: "claude-fable-5-2", label: "Fable 5.2" },
  ];
  readonly defaultModel = "sonnet";

  constructor(private workDir: string) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const bin = await findClaude();
    if (req.signal.aborted) throw abortError();

    const args = [
      "-p",
      req.resume ? req.messages[req.messages.length - 1].content : transcript(req.messages),
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--system-prompt", req.system,
      "--model", req.model,
      // A plain text-in, text-out call: no tools, no user/project settings, no MCP servers.
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
    ];
    if (req.resume) args.push("--resume", req.resume);

    // Without ANTHROPIC_API_KEY the CLI uses the signed-in subscription.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...COMMON_DIRS, process.env.PATH].join(":") };
    delete env.ANTHROPIC_API_KEY;

    fs.mkdirSync(this.workDir, { recursive: true });
    const child = spawn(bin, args, { cwd: this.workDir, env, stdio: ["ignore", "pipe", "pipe"] });
    debug("spawned", bin, "pid", child.pid, "model", req.model);
    const stop = () => child.kill("SIGTERM");
    req.signal.addEventListener("abort", stop, { once: true });

    let text = "";
    let sessionId = req.resume ?? "";
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
          req.onText(text);
        } else if (msg.type === "result") {
          if (msg.is_error || msg.subtype !== "success") resultError = String(msg.result ?? msg.subtype);
          else if (typeof msg.result === "string" && msg.result.length >= text.length) text = msg.result;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    return new Promise<ChatResult>((resolve, reject) => {
      child.on("close", (code, signal) => {
        req.signal.removeEventListener("abort", stop);
        debug("closed", code, signal, stderr.slice(-500));
        if (signal || req.signal.aborted) return reject(abortError());
        if (resultError || code !== 0) {
          const detail = resultError || stderr.trim().split("\n").slice(-3).join(" ") || `claude exited with code ${code}`;
          return reject(new Error(detail));
        }
        resolve({ text, resume: sessionId || undefined });
      });
      child.on("error", (err) => {
        req.signal.removeEventListener("abort", stop);
        reject(err);
      });
    });
  }
}

/** Without a session to resume, earlier turns go into the prompt as a transcript. */
function transcript(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  const earlier = messages
    .slice(0, -1)
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n\n");
  return `<conversation-so-far>\n${earlier}\n</conversation-so-far>\n\n${messages[messages.length - 1].content}`;
}
