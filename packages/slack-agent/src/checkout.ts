import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readOriginRepo } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

import type { ReportContext } from "./thread.ts";

const missingPathSchema = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });
const repoToken = /[a-z0-9_-]+(?:\.[a-z0-9_-]+)*/.source;
const repoPath = `${repoToken}/${repoToken}`;
const urlSuffix = /(?:\/[^\s>|)`]+)?\/?(?:[?#][^\s>|)`]+)?/.source;
const otherURL = /https?:\/\/[^\s>|)`]+/.source;
const tokenStart = /(?<![\w./:@-])/.source;
const tokenEnd = /(?![\w/@-]|\.[\w.-])/.source;
const repoReference = new RegExp(
  `https?://github\\.com/(${repoPath})${urlSuffix}|${otherURL}|${tokenStart}(?:(${repoPath})|(${repoToken}))${tokenEnd}`,
  "gi",
);

type CheckoutOptions = { repos: Record<string, string>; roots: readonly string[] };
export type Checkout = { name: string; directory?: string; aliases: readonly string[] };

export function expandHomePath(path: string) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path === "~" ? homedir() : path;
}

function ignoreMissingPath(error: Error) {
  if (!missingPathSchema.safeParse(error).success) {
    throw error;
  }
}

async function listChildDirectories(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(ignoreMissingPath);
  return (entries ?? []).flatMap((entry) => (entry.isDirectory() ? [join(root, entry.name)] : []));
}

export async function resolveExistingDirectory(path: string) {
  const directory = expandHomePath(path);
  const info = await stat(directory).catch(ignoreMissingPath);
  if (info?.isDirectory()) {
    return directory;
  }
}

async function discoverCheckout(directory: string) {
  const git = await stat(join(directory, ".git")).catch(ignoreMissingPath);
  if (!git) {
    return;
  }
  const repo = await readOriginRepo(directory);
  const folder = basename(directory);
  const name = repo?.name ?? folder;
  return { name, directory, aliases: [basename(name), folder] };
}

export async function discoverCheckouts({ repos, roots }: CheckoutOptions) {
  const mapped = await Promise.all(
    Object.entries(repos).map(async ([name, path]) => {
      return {
        name,
        directory: await resolveExistingDirectory(path),
        aliases: [basename(name)],
      };
    }),
  );
  const childDirectories = (
    await Promise.all(roots.map((root) => listChildDirectories(expandHomePath(root))))
  ).flat();
  const discovered = await Promise.all(childDirectories.map(discoverCheckout));
  return [...mapped, ...discovered].flatMap((checkout) => (checkout ? [checkout] : []));
}

function resolveCheckout(name: string, checkouts: readonly Checkout[]) {
  const normalized = name.toLowerCase();
  const matches = checkouts.filter(
    (checkout) =>
      checkout.name.toLowerCase() === normalized ||
      (!name.includes("/") && checkout.aliases.some((alias) => alias.toLowerCase() === normalized)),
  );
  return matches.find((checkout) => checkout.directory) ?? matches[0];
}

export function parseRepoReference(text: string, checkouts: readonly Checkout[]) {
  let bare: { name: string; token: string } | undefined;
  for (const [token, url, qualified, word] of text.matchAll(repoReference)) {
    if (url) {
      return { name: url.replace(/\.git$/i, ""), token };
    }
    if (qualified) {
      return { name: qualified.replace(/\.git$/i, ""), token };
    }
    if (!bare && word && resolveCheckout(word, checkouts)) {
      bare = { name: word, token };
    }
  }
  return bare;
}

export function isRepoOnlyMessage(text: string, token: string) {
  const index = text.indexOf(token);
  const before = text.slice(0, index);
  const after = text.slice(index + token.length).replace(/^\|[^>]*>/, ">");
  return /^(?:in)?$/i.test(before.replace(/[\s`*_(<]/g, "")) && /^[\s`*_.)!>]*$/.test(after);
}

export function chooseCheckout(
  request: string,
  earlierMentions: readonly string[],
  report: ReportContext,
  checkouts: readonly Checkout[],
) {
  const current = parseRepoReference(request, checkouts);
  const reference =
    current ?? earlierMentions.map((text) => parseRepoReference(text, checkouts)).find(Boolean);
  const name = reference?.name ?? report.repo?.name;
  return {
    name,
    directory:
      (name ? resolveCheckout(name, checkouts)?.directory : undefined) ??
      (!reference && report.directory ? expandHomePath(report.directory) : undefined),
    isRepoOnly: current ? isRepoOnlyMessage(request, current.token) : false,
  };
}

export function composeCheckoutReply(checkouts: readonly Checkout[], missingName?: string) {
  const names = new Map<string, string>();
  for (const { name, directory } of checkouts) {
    const key = name.toLowerCase();
    if (directory && !names.has(key)) {
      names.set(key, name);
    }
  }
  const sorted = Array.from(names.values()).sort((first, second) =>
    first.localeCompare(second, "en", { sensitivity: "base" }),
  );
  const limit = 20;
  const listed = sorted
    .slice(0, limit)
    .map((name) => `\`${name}\``)
    .join(", ");
  const remaining = sorted.length > limit ? `, and ${sorted.length - limit} more` : "";
  return [
    missingName
      ? `:warning: I couldn't find a local checkout of \`${missingName}\`.`
      : "Which repo should I use?",
    listed ? `Known repos: ${listed}${remaining}.` : "No local checkouts are configured or were found.",
    "Reply `@OpenCode <repo>` to choose a repo.",
  ].join("\n");
}
