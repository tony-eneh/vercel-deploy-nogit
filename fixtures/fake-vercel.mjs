#!/usr/bin/env node

/**
 * Stands in for the Vercel CLI so the suite can prove the mechanism without
 * deploying anything. It reports its arguments and, crucially, whether git
 * metadata was reachable from its working directory.
 */

import { execFileSync } from "node:child_process";

process.stdout.write(`ARGS:${JSON.stringify(process.argv.slice(2))}\n`);

let git = "fail";
try {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    stdio: "pipe",
  })
    .toString()
    .trim();
  git = `ok:${sha}`;
} catch {
  git = "fail";
}

process.stdout.write(`GIT:${git}\n`);
process.exit(Number(process.env.FAKE_VERCEL_EXIT ?? 0));
