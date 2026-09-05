import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const isWindows = process.platform === "win32";

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * On Windows a global npm install puts both `vercel` (a shell script Windows
 * cannot execute) and `vercel.cmd` next to each other, so the PATHEXT variants
 * have to be tried before the bare name or we pick the unusable one.
 */
function withExtensions(base, env) {
  if (!isWindows) return [base];
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...extensions.map((extension) => base + extension), base];
}

function firstFile(candidates) {
  return candidates.find(isFile) ?? null;
}

/**
 * Find an executable, preferring a locally installed one over a global.
 *
 * Order: an explicit path, then `node_modules/.bin` walking up from `cwd`,
 * then PATH. Returns an absolute path, or null when nothing matches.
 */
export function resolveBin(name, { cwd = process.cwd(), env = process.env } = {}) {
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return firstFile(withExtensions(resolve(cwd, name), env));
  }

  let directory = resolve(cwd);
  for (;;) {
    const hit = firstFile(withExtensions(join(directory, "node_modules", ".bin", name), env));
    if (hit) return hit;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const hit = firstFile(withExtensions(join(entry, name), env));
    if (hit) return hit;
  }

  return null;
}

/**
 * Map a launcher to the JavaScript file behind it.
 *
 * Worth the trouble because Node refuses to spawn a `.cmd` or `.bat` without a
 * shell (the fix for CVE-2024-27980), and turning the shell on would make every
 * passed through argument a quoting hazard. Running the entry point with node
 * avoids the shell completely and behaves the same everywhere.
 *
 * Returns an absolute path to a `.js` file, or null.
 */
export function resolveNodeEntry(binPath, name) {
  if (/\.[cm]?js$/i.test(binPath)) return binPath;

  const directory = dirname(binPath);
  const manifests = [
    // node_modules/.bin/x  ->  node_modules/x
    join(directory, "..", name, "package.json"),
    // Windows global npm: <prefix>/x.cmd -> <prefix>/node_modules/x
    join(directory, "node_modules", name, "package.json"),
    // Unix global npm: <prefix>/bin/x -> <prefix>/lib/node_modules/x
    join(directory, "..", "lib", "node_modules", name, "package.json"),
  ];

  for (const manifest of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }

    const bin = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.[name];
    if (!bin) continue;

    const entry = resolve(dirname(manifest), bin);
    if (isFile(entry)) return entry;
  }

  return null;
}
