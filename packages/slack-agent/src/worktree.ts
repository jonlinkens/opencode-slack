import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { shortenThreadTimestamp, type ReportContext } from "./thread.ts";

const executeFile = promisify(execFile);
const gitOutputSchema = z.object({ stdout: z.string() });
const missingSymbolicRefSchema = z.object({ code: z.literal(1) });
const localPrefix = "refs/heads/";
const originPrefix = "refs/remotes/origin/";

export const worktreesOptionSchema = z.enum(["auto", "always", "never"]).default("auto");

type WorktreesOption = z.output<typeof worktreesOptionSchema>;
type GitState = { currentBranch?: string; isClean: boolean; defaultBranch?: string };
type SessionCheckout = { directory: string; explanation: string; worktreeBranch?: string };
type CheckoutPlan =
  | { kind: "checkout"; explanation: string }
  | {
      kind: "worktree";
      targetBranch: string;
      reason: string;
    };

export function planSessionCheckout(
  state: GitState,
  mode: WorktreesOption,
  reportBranch?: string,
): CheckoutPlan {
  const checkout = state.currentBranch ? `on branch \`${state.currentBranch}\`` : "at a detached HEAD";
  if (mode === "never") {
    return { kind: "checkout", explanation: `You are in the checkout ${checkout}. Worktrees are disabled.` };
  }
  const targetBranch = reportBranch ?? state.defaultBranch;
  if (!targetBranch) {
    throw new Error("No default branch found (origin/HEAD, main, or master).");
  }
  if (mode === "auto" && state.currentBranch === targetBranch && state.isClean) {
    return { kind: "checkout", explanation: `You are in the checkout ${checkout}. It is clean.` };
  }
  return {
    kind: "worktree",
    targetBranch,
    reason:
      mode === "always"
        ? "worktrees are set to always"
        : `the checkout is ${checkout}${state.isClean ? "" : " with uncommitted changes"}`,
  };
}

async function runGit(directory: string, args: readonly string[], timeout?: number) {
  const output = await executeFile("git", ["--no-optional-locks", ...args], {
    cwd: directory,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout,
  });
  return gitOutputSchema.parse(output).stdout;
}

async function readGitRefs(directory: string) {
  const output = await runGit(directory, ["for-each-ref", "--format=%(refname)", localPrefix, originPrefix]);
  return new Set(output.trimEnd().split("\n").filter(Boolean));
}

function findDefaultBranch(refs: ReadonlySet<string>, originHead?: string) {
  if (originHead?.startsWith(originPrefix)) {
    return originHead.slice(originPrefix.length);
  }
  return ["main", "master"].find(function (branch) {
    return refs.has(`${localPrefix}${branch}`) || refs.has(`${originPrefix}${branch}`);
  });
}

async function readGitState(directory: string): Promise<GitState> {
  const [currentBranch, status, refs, originHead] = await Promise.all([
    runGit(directory, ["branch", "--show-current"]),
    runGit(directory, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]),
    readGitRefs(directory),
    runGit(directory, ["symbolic-ref", "--quiet", `${originPrefix}HEAD`]).catch(function (error) {
      if (!missingSymbolicRefSchema.safeParse(error).success) {
        throw error;
      }
    }),
  ]);
  return {
    currentBranch: currentBranch.trimEnd() || undefined,
    isClean: status.length === 0,
    defaultBranch: findDefaultBranch(refs, originHead?.trimEnd()),
  };
}

async function findThreadWorktree(directory: string, branchRef: string) {
  const output = await runGit(directory, ["worktree", "list", "--porcelain", "-z"]);
  for (const record of output.split("\0\0").slice(1)) {
    const [path, ...fields] = record.split("\0");
    const isPrunable = fields.some(function (field) {
      return field.startsWith("prunable");
    });
    if (!isPrunable && fields.includes(`branch ${branchRef}`) && path.startsWith("worktree ")) {
      const worktree = path.slice("worktree ".length);
      if (worktree !== directory) {
        return worktree;
      }
    }
  }
}

async function fetchTargetBranch(directory: string, targetBranch: string) {
  const local = `${localPrefix}${targetBranch}`;
  const remote = `${originPrefix}${targetBranch}`;
  await runGit(directory, ["check-ref-format", local]);
  await runGit(directory, ["check-ref-format", "--branch", targetBranch]);
  await runGit(
    directory,
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      "origin",
      `+${local}:${remote}`,
    ],
    10_000,
  ).catch(function () {});
  const refs = await readGitRefs(directory);
  if (refs.has(local)) {
    return local;
  }
  if (refs.has(remote)) {
    return remote;
  }
  throw new Error(`Target branch \`${targetBranch}\` does not exist locally or on origin.`);
}

const threadTimestampSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

export async function prepareSessionCheckout(
  checkout: string,
  report: ReportContext,
  threadTimestamp: string,
  mode: WorktreesOption,
): Promise<SessionCheckout> {
  const plan = planSessionCheckout(await readGitState(checkout), mode, report.branch);
  if (plan.kind === "checkout") {
    return { directory: checkout, explanation: plan.explanation };
  }

  const source = await realpath(checkout);
  const branch = report.id
    ? `fb/${report.id.slice("fb_".length)}`
    : `slack/${shortenThreadTimestamp(threadTimestampSchema.parse(threadTimestamp))}`;
  const branchRef = `${localPrefix}${branch}`;
  const existing = await findThreadWorktree(source, branchRef);
  if (existing) {
    return {
      directory: existing,
      worktreeBranch: branch,
      explanation: `You are reusing this thread's worktree on branch \`${branch}\` because ${plan.reason}. The target branch is \`${plan.targetBranch}\`.`,
    };
  }

  const parent = join(dirname(source), `${basename(source)}.worktrees`);
  const directory = join(parent, branch.replace("/", "-"));
  const hasBranch = (await readGitRefs(source)).has(branchRef);
  const base = hasBranch ? undefined : await fetchTargetBranch(source, plan.targetBranch);
  await mkdir(parent, { recursive: true });
  await runGit(source, [
    "worktree",
    "add",
    ...(base ? ["--no-track", "-b", branch, "--", directory, base] : ["--", directory, branch]),
  ]);
  const basis = base ? `based on \`${plan.targetBranch}\`` : "using the existing branch for this thread";
  return {
    directory,
    worktreeBranch: branch,
    explanation: `You are in a new worktree on branch \`${branch}\` ${basis} because ${plan.reason}.`,
  };
}
