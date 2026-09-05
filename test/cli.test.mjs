import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "..", "bin", "cli.mjs");
const FAKE_VERCEL = join(HERE, "..", "fixtures", "fake-vercel.mjs");

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "vdng-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function initRepository(directory) {
  // Point hooks at an empty directory so a contributor's global hooks, commit
  // message policies and signing config cannot reach these fixtures.
  const hooks = join(directory, ".no-hooks");
  mkdirSync(hooks, { recursive: true });

  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.hooksPath", hooks);
  git("config", "commit.gpgsign", "false");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--quiet", "--allow-empty", "-m", "first");
  return directory;
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function runFakeDirectly(cwd) {
  return spawnSync(process.execPath, [FAKE_VERCEL], { cwd, encoding: "utf8" });
}

describe("the mechanism", () => {
  it("hides git metadata from the spawned command", () => {
    const repository = initRepository(makeTemporaryDirectory());

    // Without the wrapper the command can read the repository, which is the
    // whole reason Vercel blocks these deployments.
    assert.match(runFakeDirectly(repository).stdout, /GIT:ok:/);

    const result = runCli(["--vercel-bin", FAKE_VERCEL, "--prod"], { cwd: repository });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /GIT:fail/);
  });

  it("hides a parent repository too, which parking cannot", () => {
    const outer = initRepository(makeTemporaryDirectory());
    const inner = join(outer, "packages", "site");
    mkdirSync(inner, { recursive: true });

    // git walks up, so the inner directory inherits the outer repository.
    assert.match(runFakeDirectly(inner).stdout, /GIT:ok:/);

    const result = runCli(["--vercel-bin", FAKE_VERCEL], { cwd: inner });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /GIT:fail/);
  });

  it("passes the exit code through", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--vercel-bin", FAKE_VERCEL], {
      cwd: repository,
      env: { FAKE_VERCEL_EXIT: "3" },
    });
    assert.equal(result.status, 3);
  });
});

describe("the park strategy", () => {
  it("hides metadata and puts .git back", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--strategy=park", "--vercel-bin", FAKE_VERCEL], { cwd: repository });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /GIT:fail/);
    assert.ok(existsSync(join(repository, ".git")), ".git should be restored");
    assert.ok(!existsSync(join(repository, ".git-deploy-tmp")), "nothing should be left parked");
  });

  it("puts .git back when the command fails", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--strategy=park", "--vercel-bin", FAKE_VERCEL], {
      cwd: repository,
      env: { FAKE_VERCEL_EXIT: "3" },
    });

    assert.equal(result.status, 3);
    assert.ok(existsSync(join(repository, ".git")), ".git should be restored after a failure");
  });

  it("refuses when the repository is only a parent, and says why", () => {
    const outer = initRepository(makeTemporaryDirectory());
    const inner = join(outer, "packages", "site");
    mkdirSync(inner, { recursive: true });

    const result = runCli(["--strategy=park", "--vercel-bin", FAKE_VERCEL], { cwd: inner });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parent directory is a git repository/);
  });
});

describe("arguments", () => {
  it("passes vercel arguments through in order, after deploy", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--vercel-bin", FAKE_VERCEL, "--prod", "--yes"], { cwd: repository });
    assert.match(result.stdout, /ARGS:\["deploy","--prod","--yes"\]/);
  });

  it("stops claiming flags after a bare --", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--vercel-bin", FAKE_VERCEL, "--", "--strategy=park"], {
      cwd: repository,
    });

    // --strategy after -- belongs to vercel, so it must not change ours.
    assert.match(result.stdout, /ARGS:\["deploy","--strategy=park"\]/);
    assert.ok(!existsSync(join(repository, ".git-deploy-tmp")));
  });

  it("rejects an unknown strategy", () => {
    const result = runCli(["--strategy=nonsense"], { cwd: makeTemporaryDirectory() });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown strategy/);
  });

  it("runs nothing under --dry-run", () => {
    const repository = initRepository(makeTemporaryDirectory());
    const result = runCli(["--dry-run", "--vercel-bin", FAKE_VERCEL, "--prod"], {
      cwd: repository,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /executable/);
    assert.ok(!result.stdout.includes("GIT:"), "the command should not have run");
  });

  it("prints a version", () => {
    const result = runCli(["--version"], { cwd: makeTemporaryDirectory() });
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
