import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { extractJson } from "../claude/json.js";
import { logger } from "../utils/logger.js";
import type {
  JsonRequest,
  JsonResponse,
  JsonSchema,
  LlmProvider,
  VisionJsonRequest,
} from "./types.js";

const ARRAY_WRAPPER_KEY = "items";
const STDERR_TAIL_LENGTH = 4_000;
// codex exec echoes the whole prompt into its stderr banner, so a tail-only
// buffer scrolls the actual error off the end. Keep both ends.
const STDERR_HEAD_LENGTH = 1_000;
const REASONING_EFFORT = "medium";

// Capacity and rate limits are transient and WILL occur across a 700-clip batch
// ("Selected model is at capacity" was observed in practice). Retry those;
// never retry a schema or usage error, which would just burn quota.
const RETRYABLE_PATTERNS = [
  /at capacity/i,
  /rate.?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /\b(429|500|502|503|504)\b/,
  /timed out/i,
  /connection (reset|closed|refused)/i,
];
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

let cachedCodexCommand: { command: string; prefixArgs: string[] } | null = null;

// We must spawn Codex WITHOUT a shell (see the comment at the spawn site), but
// npm installs it on Windows as codex.cmd — and Node refuses to spawn .cmd/.bat
// with shell:false (EINVAL, the CVE-2024-27980 mitigation). So do exactly what
// the .cmd shim does: run its JS entry point with the current Node binary.
function resolveCodexCommand(): { command: string; prefixArgs: string[] } {
  if (cachedCodexCommand) return cachedCodexCommand;
  if (process.platform !== "win32") {
    cachedCodexCommand = { command: "codex", prefixArgs: [] };
    return cachedCodexCommand;
  }

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  // A real executable can be spawned directly.
  for (const dir of pathDirs) {
    for (const ext of [".exe", ".com"]) {
      const candidate = join(dir, `codex${ext}`);
      if (existsSync(candidate)) {
        cachedCodexCommand = { command: candidate, prefixArgs: [] };
        return cachedCodexCommand;
      }
    }
  }

  // Otherwise find the shim and use the JS entry point beside it.
  for (const dir of pathDirs) {
    for (const ext of [".cmd", ".bat", ""]) {
      if (!existsSync(join(dir, `codex${ext}`))) continue;
      const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(entry)) {
        cachedCodexCommand = { command: process.execPath, prefixArgs: [entry] };
        return cachedCodexCommand;
      }
    }
  }

  throw new Error(
    "Codex CLI not found on PATH. Install it (npm i -g @openai/codex) or set VIDEOSCAN_PROVIDER=anthropic.",
  );
}

function isRetryable(stderr: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

// child.kill() only reaches the immediate child; on Windows a grandchild keeps
// the inherited pipes open, so 'close' never fires and the timeout never lands.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

interface CommandResult {
  exitCode: number | null;
  stderrTail: string;
  timedOut: boolean;
}

interface RetryableError extends Error {
  retryable?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Bounded retry around one codex invocation. A 700-clip unattended batch will
// hit capacity limits; without this each blip permanently fails that clip and
// discards the ASR/keyframe work already done for it.
async function runCodexWithRetry(
  model: string,
  timeoutMs: number,
  request: JsonRequest | VisionJsonRequest,
): Promise<JsonResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await runCodex(model, timeoutMs, request);
    } catch (error) {
      lastError = error;
      const retryable = (error as RetryableError).retryable === true;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw error;
      const delay = RETRY_DELAYS_MS[attempt] ?? 0;
      logger.warn("codex transient failure; retrying", {
        model,
        attempt: attempt + 1,
        of: RETRY_DELAYS_MS.length,
        retry_in_ms: delay,
        error: String(error).slice(0, 300),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

function appendTail(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString();
  if (combined.length <= STDERR_HEAD_LENGTH + STDERR_TAIL_LENGTH) return combined;
  // Head keeps the invocation banner and any early fatal error; tail keeps the
  // final failure. The prompt echo in between is what gets dropped.
  return (
    combined.slice(0, STDERR_HEAD_LENGTH)
    + "\n…[stderr truncated]…\n"
    + combined.slice(-STDERR_TAIL_LENGTH)
  );
}

function errorDetails(model: string, exitCode: number | null, stderrTail: string): string {
  const stderr = stderrTail.trim() || "(no stderr)";
  return `model=${model}, exit_code=${exitCode ?? "unknown"}, stderr_tail=${stderr}`;
}

function isArraySchema(schema: JsonSchema): boolean {
  return schema.type === "array";
}

function cliSchema(schema: JsonSchema): JsonSchema {
  if (!isArraySchema(schema)) return schema;

  // Some structured-output backends require a top-level object. Layer 4's
  // contract is a bare array, so Codex gets an object wrapper and this provider
  // unwraps it before returning to the Layer 4 validator.
  return {
    type: "object",
    properties: { [ARRAY_WRAPPER_KEY]: schema },
    required: [ARRAY_WRAPPER_KEY],
    additionalProperties: false,
  };
}

function cliPrompt(request: JsonRequest, wrapsArray: boolean): string {
  const wrapperInstruction = wrapsArray
    ? `\n\nThe output schema requires an object wrapper. Return the requested JSON array in the \"${ARRAY_WRAPPER_KEY}\" property and no other properties.`
    : "";
  return `${request.system.text}${wrapperInstruction}\n\n${request.prompt}`;
}

async function runCodex(
  model: string,
  timeoutMs: number,
  request: JsonRequest | VisionJsonRequest,
): Promise<JsonResponse> {
  const dir = await mkdtemp(join(tmpdir(), "videoscan-codex-"));
  const schemaPath = join(dir, "schema.json");
  const promptPath = join(dir, "prompt.txt");
  const outputPath = join(dir, "output.json");
  const wrapsArray = isArraySchema(request.schema);

  try {
    const images = "images" in request ? request.images : [];
    const imageLabels = images.map((image, index) => `Image ${index + 1}: ${image.label}`);
    await Promise.all([
      writeFile(schemaPath, JSON.stringify(cliSchema(request.schema))),
      // Codex receives every prompt over stdin so long transcripts never hit
      // Windows' command-line length limit.
      writeFile(
        promptPath,
        `${cliPrompt(request, wrapsArray)}${imageLabels.length ? `\n\n${imageLabels.join("\n")}` : ""}`,
      ),
    ]);

    const args = [
      "exec",
      "-m",
      model,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      // Without this the CLI inherits ~/.codex/config.toml, where a human's
      // interactive setting (e.g. model_reasoning_effort = "xhigh") would apply
      // to every call in a 700-clip batch — slower and more capacity-prone.
      // CLAUDE.md mandates bounded medium effort for pipeline calls.
      "-c",
      `model_reasoning_effort=${REASONING_EFFORT}`,
      "--output-schema",
      schemaPath,
      ...images.flatMap((image) => ["-i", image.path]),
      "-o",
      outputPath,
      "-",
    ];
    const result = await new Promise<CommandResult>((resolve, reject) => {
      // Resolve the Codex executable and spawn it DIRECTLY (shell: false).
      // Routing through cmd.exe caps the whole command line at 8191 chars, and
      // the -i image list lives on argv: a clip with ~80+ detected scenes blew
      // that limit and failed with an untranslatable shell error. Spawning the
      // binary directly raises the ceiling to 32767.
      const { command, prefixArgs } = resolveCodexCommand();
      const child = spawn(command, [...prefixArgs, ...args], {
        stdio: ["pipe", "ignore", "pipe"],
        shell: false,
      });
      let stderrTail = "";
      let settled = false;
      const promptStream = createReadStream(promptPath);
      const cleanup = (): void => {
        clearTimeout(timeout);
        promptStream.destroy();
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Settle from the timer itself. Waiting for 'close' is what made the
        // old timeout decorative: the grandchild held the pipes open, so a 4s
        // timeout only rejected once the run finished ~86s later.
        killTree(child.pid);
        cleanup();
        resolve({ exitCode: null, stderrTail, timedOut: true });
      }, timeoutMs);

      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Codex CLI could not start (${errorDetails(model, null, stderrTail)}): ${String(error)}`,
          ),
        );
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ exitCode, stderrTail, timedOut: false });
      });

      promptStream.once("error", (error) => {
        if (settled) return;
        settled = true;
        killTree(child.pid);
        cleanup();
        reject(
          new Error(
            `Codex CLI could not read its prompt (${errorDetails(model, null, stderrTail)}): ${String(error)}`,
          ),
        );
      });
      // A dead child makes the pipe throw EPIPE; the close/error handlers above
      // already carry the real diagnosis, so don't let it crash the process.
      child.stdin.on("error", () => {});
      promptStream.pipe(child.stdin);
    });

    if (result.timedOut) {
      throw new Error(
        `Codex CLI timed out after ${timeoutMs}ms (${errorDetails(model, result.exitCode, result.stderrTail)})`,
      );
    }
    if (result.exitCode !== 0) {
      const error = new Error(
        `Codex CLI failed (${errorDetails(model, result.exitCode, result.stderrTail)})`,
      );
      // Marked so the retry wrapper can distinguish a transient capacity blip
      // from a schema/usage error that would just burn quota on retry.
      (error as RetryableError).retryable = isRetryable(result.stderrTail);
      throw error;
    }

    let output: string;
    try {
      output = await readFile(outputPath, "utf8");
    } catch (error) {
      throw new Error(
        `Codex CLI did not write an output file (${errorDetails(model, result.exitCode, result.stderrTail)}): ${String(error)}`,
      );
    }
    if (!output.trim()) {
      throw new Error(`Codex CLI wrote empty output (${errorDetails(model, result.exitCode, result.stderrTail)})`);
    }

    try {
      const parsed: unknown = JSON.parse(extractJson(output));
      if (wrapsArray) {
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray((parsed as Record<string, unknown>)[ARRAY_WRAPPER_KEY])
        ) {
          throw new Error(`missing ${ARRAY_WRAPPER_KEY} array wrapper`);
        }
        return { text: JSON.stringify((parsed as Record<string, unknown>)[ARRAY_WRAPPER_KEY]) };
      }
      return { text: JSON.stringify(parsed) };
    } catch (error) {
      throw new Error(
        `Codex CLI returned unparseable JSON (${errorDetails(model, result.exitCode, result.stderrTail)}): ${String(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Codex CLI failed (model=${model}): ${String(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class CodexCliProvider implements LlmProvider {
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: { model: string; timeoutMs: number }) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
  }

  async generateJson(request: JsonRequest): Promise<JsonResponse> {
    return runCodexWithRetry(this.model, this.timeoutMs, request);
  }

  async generateVisionJson(request: VisionJsonRequest): Promise<JsonResponse> {
    return runCodexWithRetry(this.model, this.timeoutMs, request);
  }
}
