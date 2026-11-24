import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type Repo = { name: string; url: string };

export function parseGitRemote(remote: string): Repo | undefined {
  const match =
    remote.trim().match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/) ??
    remote.trim().match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (!match) {
    return undefined;
  }
  const [, host, path] = match;
  return { name: path, url: `https://${host}/${path}` };
}

export async function readOriginRepo(directory: string) {
  const remote = await executeFile("git", ["-C", directory, "remote", "get-url", "origin"]).catch(
    () => undefined,
  );
  return remote ? parseGitRemote(remote.stdout) : undefined;
}
