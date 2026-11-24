import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  chooseCheckout,
  composeCheckoutReply,
  discoverCheckouts,
  expandHomePath,
  parseRepoReference,
} from "../checkout.ts";

const repo = { name: "acme/app", url: "https://github.com/acme/app" };
const checkouts = [
  { name: "acme/app", directory: "/dev/local-app", aliases: ["app", "local-app"] },
  { name: "acme/site", directory: "/code/site", aliases: ["site"] },
  { name: "custom", directory: "/code/other", aliases: ["custom"] },
];
let root: string;

beforeAll(function () {
  root = mkdtempSync(join(tmpdir(), "slack-agent-"));
  const checkout = join(root, "local-app");
  mkdirSync(checkout);
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:Acme/App.git"]);
  mkdirSync(join(root, "not-a-repo"));
  execFileSync("git", ["init", "-q", join(root, "standalone")]);
});

afterAll(function () {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverCheckouts", function () {
  it("discovers origin and folder aliases and ignores non-Git directories and missing roots", async function () {
    const found = await discoverCheckouts({ repos: {}, roots: [root, join(root, "missing")] });
    expect(found).toHaveLength(2);
    expect(chooseCheckout("local-app", [], {}, found).directory).toBe(join(root, "local-app"));
    expect(chooseCheckout("standalone", [], {}, found).directory).toBe(join(root, "standalone"));
    expect(chooseCheckout("app", [], {}, found).directory).toBe(join(root, "local-app"));
  });

  it("uses a map entry before a discovered origin, ignoring case", async function () {
    const mapped = join(root, "not-a-repo");
    const found = await discoverCheckouts({ repos: { "acme/app": mapped }, roots: [root] });
    expect(chooseCheckout("Acme/App", [], {}, found).directory).toBe(mapped);
  });

  it("does not treat a mapped path that no longer exists as a checkout", async function () {
    const found = await discoverCheckouts({ repos: { "acme/old": join(root, "removed") }, roots: [] });
    expect(chooseCheckout("old", [], {}, found)).toMatchObject({
      name: "old",
      directory: undefined,
    });
  });
});

describe("parseRepoReference", function () {
  it.each([
    ["in APP fix the login bug", "APP"],
    ["(local-APP)", "local-APP"],
    ["`custom`", "custom"],
    ["look at Acme/Site, please", "Acme/Site"],
    ["<https://github.com/acme/site.git|source>", "acme/site"],
    ["https://github.com/acme/site/issues/23", "acme/site"],
    ["app in acme/site", "acme/site"],
    ["happy apps local-app-old app.config app.ts src/local-app/view.ts", undefined],
    ["https://example.com/acme/site", undefined],
  ])("parses %s", function (text, name) {
    expect(parseRepoReference(text, checkouts)?.name).toBe(name);
  });
});

describe("chooseCheckout", function () {
  it("uses the current mention before earlier mentions and the report", function () {
    expect(chooseCheckout("in local-app", ["acme/site"], { repo }, checkouts)).toEqual({
      name: "local-app",
      directory: "/dev/local-app",
      isRepoOnly: true,
    });
  });

  it("uses the most recent earlier repo mention before report context", function () {
    expect(chooseCheckout("fix this", ["please", "site", "custom"], { repo }, checkouts).directory).toBe(
      "/code/site",
    );
  });

  it("uses the report repo then its folder if nothing is named", function () {
    expect(chooseCheckout("fix this", [], { repo, directory: "~/dev" }, checkouts).directory).toBe(
      "/dev/local-app",
    );
    expect(chooseCheckout("fix this", [], { repo, directory: "~/dev" }, []).directory).toBe(
      join(homedir(), "dev"),
    );
  });

  it("does not silently use report context for an explicit repo without a checkout", function () {
    expect(chooseCheckout("acme/missing", [], { repo, directory: "~/dev" }, checkouts)).toMatchObject({
      name: "acme/missing",
      directory: undefined,
    });
  });

  it("distinguishes Slack link selectors from links with requests", function () {
    const link = "<https://github.com/acme/site|site>";
    expect(chooseCheckout(link, [], {}, checkouts).isRepoOnly).toBe(true);
    expect(chooseCheckout(`${link} fix login`, [], {}, checkouts).isRepoOnly).toBe(false);
  });
});

describe("composeCheckoutReply", function () {
  it("sorts and deduplicates known repos and tells the user how to choose", function () {
    expect(composeCheckoutReply(checkouts.slice().reverse().concat(checkouts))).toBe(
      "Which repo should I use?\nKnown repos: `acme/app`, `acme/site`, `custom`.\nReply `@OpenCode <repo>` to choose a repo.",
    );
  });

  it("identifies a repo with no checkout and caps the list", function () {
    const known = Array.from({ length: 22 }, function (_, index) {
      return { name: `repo-${String(index).padStart(2, "0")}`, directory: "/dev", aliases: [] };
    });
    const reply = composeCheckoutReply(known, "acme/missing");
    expect(reply).toContain("I couldn't find a local checkout of `acme/missing`.");
    expect(reply).toContain("`repo-19`, and 2 more.");
    expect(reply).not.toContain("repo-20");
    expect(composeCheckoutReply([])).toContain("No local checkouts are configured or were found.");
  });
});

describe("expandHomePath", () => {
  it("expands ~ only at the start", () => {
    expect(expandHomePath("~/dev")).toBe(join(homedir(), "dev"));
    expect(expandHomePath("/tmp/~x")).toBe("/tmp/~x");
  });
});
