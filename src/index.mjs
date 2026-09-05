import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveBin, resolveNodeEntry } from "./resolve-bin.mjs";

const isWindows = process.platform === "win32";

export const STRATEGIES = Object.freeze(["env", "park"]);

/** Where the `park` strategy puts `.git` for the duration of the command. */
export const PARKED_DIRECTORY_NAME = ".git-deploy-tmp";

/**
 * An environment in which git refuses to work.
 *
 * The Vercel CLI collects commit metadata through `git-last-commit`, which
 * shells out to git with `exec(command, { cwd })` and does not pass `env`, so
 * the child git process inherits whatever we set here. Pointing GIT_DIR at a
 * path that does not exist makes that git call fail, which makes the CLI's
 * `createGitMeta` return undefined, which means no metadata is attached.
 *
 * GIT_DIR also overrides repository discovery outright, so this works even when
 * a parent directory is a git repository.
 */
export function suppressedGitEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  env.GIT_DIR = join(tmpdir(), `vercel-deploy-nogit-${randomUUID()}`);
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return env;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Renaming `.git` fails on Windows while an editor, a file watcher or a
 * background git process holds a handle to it. Those handles are usually
 * released within a moment, so retry rather than give up.
 */
function renameWithRetry(from, to, { attempts = 6, delayMilliseconds = 150 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepSync(delayMilliseconds);
    }
  }
  throw lastError;
}

function gitRepositoryVisible(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves `.git` aside and puts it back, however the process ends.
 *
 * This is the fallback strategy. It mutates the filesystem, so everything here
 * is about making sure the repository comes back.
 */
class GitParker {
  constructor(cwd, logger) {
    this.cwd = cwd;
    this.logger = logger;
    this.gitPath = join(cwd, ".git");
    this.parkedPath = join(cwd, PARKED_DIRECTORY_NAME);
    this.parked = false;
    this.handlers = [];
  }

  park() {
    if (existsSync(this.parkedPath)) {
      if (existsSync(this.gitPath)) {
        throw new Error(
          `Both .git and ${PARKED_DIRECTORY_NAME} exist in ${this.cwd}.\n` +
            "Work out which one you want and remove the other before deploying.",
        );
      }
      this.logger.warn(`Restoring a .git left parked by an interrupted run.`);
      renameWithRetry(this.parkedPath, this.gitPath);
    }

    if (!existsSync(this.gitPath)) {
      const inherited = gitRepositoryVisible(this.cwd);
      throw new Error(
        inherited
          ? `${this.cwd} has no .git of its own, but a parent directory is a git repository.\n` +
            "Parking cannot hide a parent repository. Use the default env strategy instead."
          : `${this.cwd} has no .git directory. Run this from the repository root.`,
      );
    }

    this.#registerHandlers();
    renameWithRetry(this.gitPath, this.parkedPath);
    this.parked = true;

    if (gitRepositoryVisible(this.cwd)) {
      this.logger.warn(
        "A parent directory is also a git repository, so git metadata is still reachable.\n" +
          "The env strategy handles this case; parking does not.",
      );
    }
  }

  restore() {
    if (!this.parked) return;
    this.parked = false;
    try {
      renameWithRetry(this.parkedPath, this.gitPath);
    } catch (error) {
      // The only failure here that really matters, so it gets shouted about.
      this.logger.error(
        `\nCould not restore .git. Put it back by hand before doing anything else:\n` +
          `  mv "${this.parkedPath}" "${this.gitPath}"\n`,
        error,
      );
    }
    this.#removeHandlers();
  }

  #registerHandlers() {
    const restore = () => this.restore();
    const onSignal = () => {
      this.restore();
      process.exit(130);
    };

    this.handlers = [
      ["exit", restore],
      ...["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].map((signal) => [signal, onSignal]),
    ];

    for (const [event, handler] of this.handlers) process.on(event, handler);
  }

  #removeHandlers() {
    for (const [event, handler] of this.handlers) process.off(event, handler);
    this.handlers = [];
  }
}

/**
 * Run something with git metadata out of reach, then put the world back.
 *
 * `run` receives `{ env }` and should use it for any child process it spawns.
 * This is the general primitive; deploying to Vercel is one caller of it.
 */
export async function withoutGitMetadata(
  run,
  { cwd = process.cwd(), strategy = "env", logger = console } = {},
) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown strategy "${strategy}". Use one of: ${STRATEGIES.join(", ")}.`);
  }

  if (strategy === "env") {
    return run({ env: suppressedGitEnv() });
  }

  const parker = new GitParker(resolve(cwd), logger);
  parker.park();
  try {
    return await run({ env: { ...process.env } });
  } finally {
    parker.restore();
  }
}

function spawnAsync(file, args, { cwd, env, stdio, shell = false }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, env, stdio, shell });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ exitCode: code ?? (signal ? 1 : 0), signal });
    });
  });
}

/**
 * Run `vercel deploy` with no git metadata attached.
 *
 * Returns `{ exitCode, signal }`. Anything in `args` is passed straight to the
 * Vercel CLI.
 */
export async function deployWithoutGitMetadata(options = {}) {
  const {
    args = [],
    command = ["deploy"],
    cwd = process.cwd(),
    strategy = "env",
    vercelBin = "vercel",
    dryRun = false,
    stdio = "inherit",
    logger = console,
  } = options;

  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown strategy "${strategy}". Use one of: ${STRATEGIES.join(", ")}.`);
  }

  const workingDirectory = resolve(cwd);
  const resolved = resolveBin(vercelBin, { cwd: workingDirectory });
  if (!resolved) {
    throw new Error(
      `Could not find "${vercelBin}". Install the Vercel CLI, or point at it with --vercel-bin.`,
    );
  }

  // Prefer running the CLI's JavaScript entry point with node. Node refuses to
  // spawn a .cmd or .bat without a shell (the fix for CVE-2024-27980), and
  // turning the shell on would make every passed through argument a quoting
  // hazard. Going straight to the entry point avoids the shell entirely.
  const entry = resolveNodeEntry(resolved, basename(resolved).replace(/\.[^.]*$/, ""));

  let file = resolved;
  let argv = [...command, ...args];
  let shell = false;

  if (entry) {
    file = process.execPath;
    argv = [entry, ...command, ...args];
  } else if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
    // Last resort: nothing found behind the launcher. Quote anything holding
    // whitespace, because a shell will otherwise re-split the arguments.
    shell = true;
    argv = argv.map((argument) => (/\s/.test(argument) ? `"${argument}"` : argument));
  }

  if (dryRun) {
    logger.log("strategy   ", strategy);
    logger.log("cwd        ", workingDirectory);
    logger.log("executable ", file);
    logger.log("arguments  ", JSON.stringify(argv));
    if (shell) logger.log("shell      ", "yes, nothing found behind the launcher");
    logger.log(
      "env change ",
      strategy === "env"
        ? `GIT_DIR set to a path under ${tmpdir()} that is never created`
        : `.git moved to ${PARKED_DIRECTORY_NAME} for the duration`,
    );
    return { exitCode: 0, signal: null, dryRun: true };
  }

  return withoutGitMetadata(({ env }) => spawnAsync(file, argv, { cwd: workingDirectory, env, stdio, shell }), {
    cwd: workingDirectory,
    strategy,
    logger,
  });
}
