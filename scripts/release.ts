import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const registry = "https://registry.npmjs.org";
const packageDirectories = ["packages/shared", "packages/slack-feedback", "packages/slack-agent"];
const manifest = z.object({ name: z.string(), version: z.string() });
const notFound = z.object({ error: z.object({ code: z.literal("E404") }) });

function isPublished(tag: string, version: string): boolean {
  const result = spawnSync("npm", ["view", tag, "version", "--json", "--registry", registry], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    z.literal(version).parse(JSON.parse(result.stdout));
    return true;
  }
  if (result.status === 1 && result.stdout.trim() && notFound.safeParse(JSON.parse(result.stdout)).success) {
    return false;
  }
  throw new Error(`npm view ${tag} failed: ${result.stderr.trim()}`);
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
  }
}

function publish(directory: string) {
  const destination = mkdtempSync(join(tmpdir(), "opencode-slack-release-"));
  const tarball = join(destination, "release.tgz");
  try {
    run("bun", ["pm", "pack", "--filename", tarball], directory);
    run(
      "npm",
      [
        "publish",
        tarball,
        "--registry",
        registry,
        "--access",
        "public",
        ...(process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : []),
      ],
      root,
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

for (const path of packageDirectories) {
  const directory = join(root, path);
  const { name, version } = manifest.parse(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")));
  const tag = `${name}@${version}`;
  if (isPublished(tag, version)) {
    console.log(`Already published: ${tag}`);
  } else if (process.argv.includes("--dry-run")) {
    console.log(`Would publish: ${tag}`);
  } else {
    publish(directory);
    run("git", ["tag", tag], root);
    console.log(`New tag: ${tag}`);
  }
}
