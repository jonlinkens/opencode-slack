import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planSessionCheckout, prepareSessionCheckout, worktreesOptionSchema } from "../worktree.ts";

describe("planSessionCheckout", function () {
  const clean = { currentBranch: "main", defaultBranch: "main", isClean: true };

  it("uses the checkout if it is clean and on the report branch or default branch", function () {
    expect(planSessionCheckout(clean, "auto")).toMatchObject({ kind: "checkout" });
    expect(planSessionCheckout({ ...clean, currentBranch: "release" }, "auto", "release")).toMatchObject({
      kind: "checkout",
    });
  });

  it("isolates a dirty, detached or different checkout", function () {
    expect(planSessionCheckout({ ...clean, isClean: false }, "auto")).toEqual({
      kind: "worktree",
      targetBranch: "main",
      reason: "the checkout is on branch `main` with uncommitted changes",
    });
    expect(planSessionCheckout({ ...clean, currentBranch: undefined }, "auto")).toMatchObject({
      kind: "worktree",
      targetBranch: "main",
      reason: "the checkout is at a detached HEAD",
    });
    expect(planSessionCheckout(clean, "auto", "release")).toMatchObject({
      kind: "worktree",
      targetBranch: "release",
    });
  });

  it("honors always and never and defaults to auto", function () {
    expect(worktreesOptionSchema.parse(undefined)).toBe("auto");
    expect(planSessionCheckout(clean, "always")).toMatchObject({ kind: "worktree", targetBranch: "main" });
    expect(planSessionCheckout({ isClean: false }, "never")).toMatchObject({ kind: "checkout" });
    expect(function () {
      planSessionCheckout({ isClean: false }, "auto");
    }).toThrow("No default branch found");
  });
});

describe("prepareSessionCheckout with real Git", function () {
  const timestamp = "1795519349.359759";
  let root: string;
  let checkout: string;

  function git(directory: string, ...args: string[]) {
    return execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-C", directory, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trimEnd();
  }

  beforeEach(function () {
    root = realpathSync(mkdtempSync(join(tmpdir(), "slack-worktree-")));
    checkout = join(root, "app");
    git(root, "init", "-q", "-b", "main", checkout);
    writeFileSync(join(checkout, "README"), "base");
    git(checkout, "add", "README");
    git(checkout, "commit", "-qm", "main");
  });

  afterEach(function () {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a report worktree from the report branch and reuses it without touching the checkout", async function () {
    git(checkout, "branch", "release");
    const release = git(checkout, "rev-parse", "release");
    git(checkout, "switch", "-qc", "feature");
    git(checkout, "commit", "--allow-empty", "-qm", "feature");
    writeFileSync(join(checkout, "README"), "staged");
    git(checkout, "add", "README");
    writeFileSync(join(checkout, "README"), "unstaged");
    writeFileSync(join(checkout, "untracked"), "untracked");
    const sourceStatus = git(checkout, "status", "--porcelain");
    const report = { id: "fb_2f94595f", branch: "release" };

    const result = await prepareSessionCheckout(checkout, report, timestamp, "auto");
    expect(result).toEqual({
      directory: join(root, "app.worktrees", "fb-2f94595f"),
      worktreeBranch: "fb/2f94595f",
      explanation:
        "You are in a new worktree on branch `fb/2f94595f` based on `release` because the checkout is on branch `feature` with uncommitted changes.",
    });
    expect(git(result.directory, "rev-parse", "HEAD")).toBe(release);
    expect(git(result.directory, "branch", "--show-current")).toBe("fb/2f94595f");
    expect(git(result.directory, "status", "--porcelain")).toBe("");
    expect(git(checkout, "branch", "--show-current")).toBe("feature");
    expect(git(checkout, "status", "--porcelain")).toBe(sourceStatus);

    writeFileSync(join(result.directory, "earlier-work"), "keep");
    const reused = await prepareSessionCheckout(checkout, report, timestamp, "auto");
    expect(reused.directory).toBe(result.directory);
    expect(reused.explanation).toContain("reusing this thread's worktree");
    expect(git(reused.directory, "status", "--porcelain")).toBe("?? earlier-work");
  });

  it("uses the checkout on the fallback default until an untracked file makes it dirty", async function () {
    git(checkout, "branch", "-m", "master");
    expect(await prepareSessionCheckout(checkout, {}, timestamp, "auto")).toMatchObject({
      directory: checkout,
    });
    git(checkout, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(checkout, "untracked"), "untracked");
    const result = await prepareSessionCheckout(checkout, {}, timestamp, "auto");
    expect(result.worktreeBranch).toBe("slack/349359759");
    expect(result.explanation).toContain("based on `master`");
  });

  it("prefers origin HEAD, fetches a remote-only target, and can use it offline later", async function () {
    const remote = join(root, "origin.git");
    git(checkout, "switch", "-qc", "release");
    git(checkout, "commit", "--allow-empty", "-qm", "release");
    git(root, "clone", "-q", "--bare", checkout, remote);
    git(checkout, "remote", "add", "origin", remote);
    git(checkout, "fetch", "-q", "origin");
    git(checkout, "remote", "set-head", "origin", "release");
    git(checkout, "switch", "-q", "main");
    git(checkout, "branch", "-D", "release");
    git(checkout, "update-ref", "-d", "refs/remotes/origin/release");

    const result = await prepareSessionCheckout(checkout, {}, timestamp, "auto");
    expect(result.explanation).toContain("based on `release`");
    const release = git(remote, "rev-parse", "release");
    expect(git(result.directory, "rev-parse", "HEAD")).toBe(release);
    git(checkout, "branch", "release", "main");
    const local = await prepareSessionCheckout(checkout, { branch: "release" }, "1.2", "always");
    expect(git(local.directory, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "main"));
    git(checkout, "branch", "-D", "release");
    git(checkout, "remote", "set-url", "origin", join(root, "offline.git"));
    const offline = await prepareSessionCheckout(checkout, { branch: "release" }, "1.3", "always");
    expect(git(offline.directory, "rev-parse", "HEAD")).toBe(release);
  });

  it("checks out an existing thread branch without resetting it", async function () {
    git(checkout, "branch", "fb/2f94595f");
    const result = await prepareSessionCheckout(checkout, { id: "fb_2f94595f" }, timestamp, "always");
    expect(git(result.directory, "branch", "--show-current")).toBe("fb/2f94595f");
    expect(result.explanation).toContain("using the existing branch");
  });

  it("fails closed when the target is unavailable or the worktree path is occupied", async function () {
    await expect(
      prepareSessionCheckout(checkout, { branch: "missing" }, timestamp, "always"),
    ).rejects.toThrow("does not exist locally or on origin");
    writeFileSync(join(root, "app.worktrees"), "occupied");
    await expect(prepareSessionCheckout(checkout, {}, timestamp, "always")).rejects.toThrow("app.worktrees");
    expect(git(checkout, "branch", "--show-current")).toBe("main");
  });
});
