import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveBin, resolveNodeEntry } from "../src/resolve-bin.mjs";

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A minimal copy of what npm leaves in node_modules for a CLI package. */
function makeInstalledCli(name = "vercel", entry = "dist/index.js") {
  const root = mkdtempSync(join(tmpdir(), "vdng-bin-"));
  temporaryDirectories.push(root);

  const packageDirectory = join(root, "node_modules", name);
  mkdirSync(join(packageDirectory, "dist"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });

  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", bin: { [name]: entry } }),
  );
  writeFileSync(join(packageDirectory, entry), "// entry point\n");

  // npm writes several launchers side by side. The extensionless one is a shell
  // script that Windows cannot execute.
  const binDirectory = join(root, "node_modules", ".bin");
  for (const suffix of ["", ".cmd", ".ps1"]) {
    writeFileSync(join(binDirectory, `${name}${suffix}`), "launcher\n");
  }

  return { root, binDirectory, entryPath: join(packageDirectory, entry) };
}

describe("resolveBin", () => {
  it("prefers a local install over anything on PATH", () => {
    const { root, binDirectory } = makeInstalledCli();
    const resolved = resolveBin("vercel", { cwd: root, env: { PATH: "", PATHEXT: ".CMD" } });
    assert.ok(resolved?.startsWith(binDirectory), `expected a local hit, got ${resolved}`);
  });

  it("finds a local install from a nested directory", () => {
    const { root, binDirectory } = makeInstalledCli();
    const nested = join(root, "apps", "site");
    mkdirSync(nested, { recursive: true });

    const resolved = resolveBin("vercel", { cwd: nested, env: { PATH: "", PATHEXT: ".CMD" } });
    assert.ok(resolved?.startsWith(binDirectory), `expected a local hit, got ${resolved}`);
  });

  it("returns null when there is nothing to find", () => {
    const root = mkdtempSync(join(tmpdir(), "vdng-bin-"));
    temporaryDirectories.push(root);
    assert.equal(resolveBin("definitely-not-installed", { cwd: root, env: { PATH: "" } }), null);
  });
});

describe("resolveNodeEntry", () => {
  it("maps a launcher back to the package entry point", () => {
    const { binDirectory, entryPath } = makeInstalledCli();
    assert.equal(resolveNodeEntry(join(binDirectory, "vercel.cmd"), "vercel"), entryPath);
  });

  it("maps an extensionless launcher too", () => {
    // Regression guard: the name is derived by stripping an extension, and a
    // launcher with no extension must not lose its last character.
    const { binDirectory, entryPath } = makeInstalledCli();
    assert.equal(resolveNodeEntry(join(binDirectory, "vercel"), "vercel"), entryPath);
  });

  it("passes a javascript path straight through", () => {
    const script = join(tmpdir(), "some-cli.mjs");
    assert.equal(resolveNodeEntry(script, "some-cli"), script);
  });

  it("returns null when nothing sits behind the launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "vdng-bin-"));
    temporaryDirectories.push(root);
    assert.equal(resolveNodeEntry(join(root, "mystery.cmd"), "mystery"), null);
  });
});
