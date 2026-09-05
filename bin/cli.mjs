#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployWithoutGitMetadata, STRATEGIES } from "../src/index.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `vercel-deploy-nogit ${version}

  Run "vercel deploy" without attaching git metadata.

Usage
  vercel-deploy-nogit [options] [-- ] [vercel arguments...]

Examples
  vercel-deploy-nogit --prod --yes
  vercel-deploy-nogit --strategy=park -- --prod --archive=tgz
  vercel-deploy-nogit --dry-run --prod

Options
  --strategy=env|park   How to hide the metadata. Default: env.
                        env   sets GIT_DIR on the spawned process only, and
                              touches nothing on disk.
                        park  moves .git aside for the duration. Use only if
                              env stops working.
  --cwd=<dir>           Directory to deploy. Default: the current one.
  --vercel-bin=<path>   Vercel CLI to run. Default: vercel, preferring a local
                        node_modules/.bin over a global install.
  --dry-run             Print what would run, and run nothing.
  --help, -h            This text.
  --version             Print the version.

Everything else is passed to "vercel deploy" untouched. Use -- before any
Vercel argument that collides with one of the options above.
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { strategy: "env", cwd: process.cwd(), vercelBin: "vercel", dryRun: false };
  let index = 0;

  for (; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--") {
      index += 1;
      break;
    }

    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined) fail(`${flag} needs a value.`);
      index += 1;
      return next;
    };

    if (flag === "--help" || flag === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (flag === "--version") {
      process.stdout.write(`${version}\n`);
      process.exit(0);
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--strategy") {
      options.strategy = takeValue();
    } else if (flag === "--cwd") {
      options.cwd = resolve(takeValue());
    } else if (flag === "--vercel-bin") {
      options.vercelBin = takeValue();
    } else {
      // First thing we do not own. Everything from here is Vercel's.
      break;
    }
  }

  return { options, args: argv.slice(index) };
}

const { options, args } = parseArguments(process.argv.slice(2));

if (!STRATEGIES.includes(options.strategy)) {
  fail(`Unknown strategy "${options.strategy}". Use one of: ${STRATEGIES.join(", ")}.`);
}

try {
  const { exitCode } = await deployWithoutGitMetadata({ ...options, args });
  process.exit(exitCode);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
