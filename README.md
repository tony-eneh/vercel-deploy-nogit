# vercel-deploy-nogit

Run `vercel deploy` without attaching git metadata.

```bash
npm i -D vercel-deploy-nogit
```

```jsonc
// package.json
"scripts": {
  "deploy": "vercel-deploy-nogit --prod --yes"
}
```

No dependencies. Works on Windows, macOS and Linux.

## The problem this solves

Vercel refuses the deployment and tells you:

> The deployment was blocked because the commit author doesn't have permission
> to create deployments for this project.

You get this when the Vercel CLI can read a git repository but Vercel cannot
match the commit author to a user with deploy rights on the project. Common
causes: the Vercel account has no git provider connected, the project is not
connected to the repository, or commits are authored by somebody who is not a
member of the Vercel team.

The failure is badly disguised. `vercel ls` shows the deployment as `UNKNOWN`
with a zero millisecond build, and no build logs, so it reads like a stuck
queue or a broken build. The real reason appears only in the deployment's API
response, as `state: BLOCKED` with an `errorMessage`.

## Read this before using it

**The proper fix is to connect the repository to Vercel** and make sure the
commit author is a team member with deploy rights. That also gives you push to
deploy, which this package does not. Do that if you can.

This package is for when you cannot, at least not today: an organisation owned
repository on a plan that does not allow connecting one, a personal account
that will never be linked to the committer, a one off deploy from a machine
that is not the usual one.

**What it costs you:** deployments made this way carry no commit information, so
the Vercel dashboard will not show the branch, the message or the author. If you
rely on that, this is the wrong tool.

**What it is not:** this is not a way around authentication or authorisation.
The deploy still needs a valid Vercel token with rights to the project, and it
fails without one. Deploying a directory that is not a git repository is
ordinary supported Vercel behaviour; this makes an existing directory look like
one for the length of a single command.

## Usage

```bash
vercel-deploy-nogit --prod --yes
vercel-deploy-nogit --dry-run --prod
vercel-deploy-nogit --strategy=park -- --prod --archive=tgz
```

Anything the tool does not recognise is passed to `vercel deploy` untouched. Put
`--` before any Vercel argument that collides with an option below.

| Option | Meaning |
| --- | --- |
| `--strategy=env\|park` | How to hide the metadata. Default `env` |
| `--cwd=<dir>` | Directory to deploy. Default: the current one |
| `--vercel-bin=<path>` | Vercel CLI to run. Default `vercel`, preferring a local `node_modules/.bin` |
| `--dry-run` | Print what would run, run nothing |
| `--help`, `-h` | Usage |
| `--version` | Version |

The exit code is the Vercel CLI's own, so this drops into CI unchanged.

## How it works

The Vercel CLI calls `createGitMeta()` on every deploy. There is no flag or
environment variable to skip it. But it collects the commit through
`git-last-commit`, which shells out with `exec(command, { cwd })` and does not
pass `env`, so the child git process inherits the environment of whatever
spawned `vercel`. And if that git call fails, `createGitMeta` returns
`undefined` and no metadata is attached.

So the default **`env` strategy** spawns `vercel` with `GIT_DIR` pointed at a
path under the temp directory that is never created. Git refuses to run, the
metadata collection gives up, and the deploy goes out clean.

Nothing is written, moved or deleted. There is no cleanup step that can fail, so
a crash or a `kill -9` leaves your repository exactly as it was. `GIT_DIR` also
overrides repository discovery, so it works when the repository is a parent
directory rather than the one you are deploying.

### The park strategy

`--strategy=park` moves `.git` aside for the duration instead, which is the
older way of doing this. It is kept as a fallback in case a future Vercel CLI
stops inheriting the environment. Prefer `env`.

It restores `.git` from an exit handler that also covers `SIGINT`, `SIGTERM`,
`SIGHUP`, `SIGBREAK` and uncaught exceptions, retries the rename when Windows
has the directory locked by an editor or a file watcher, and recovers a `.git`
left parked by an earlier interrupted run. It still cannot survive `SIGKILL`,
and it cannot hide a parent repository, so it refuses that case rather than
deploying something that will be blocked anyway.

## Programmatic use

```js
import { deployWithoutGitMetadata, withoutGitMetadata } from "vercel-deploy-nogit";

const { exitCode } = await deployWithoutGitMetadata({
  args: ["--prod", "--yes"],
  cwd: process.cwd(),
});

// The general primitive, if some other tool has the same problem.
await withoutGitMetadata(({ env }) => spawn("some-tool", [], { env }));
```

## Licence

MIT
