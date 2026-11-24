import { describe, expect, it } from "vitest";

import { composeReportMessages, toMrkdwn, hasPotentialMentions, type Report } from "../message.ts";
import { EMPTY_SLACK_DIRECTORY, type Directory } from "@jonlinkens/opencode-slack-shared";

const directory: Directory = {
  channels: new Map([["jons-agent", "C0CLJ57Q4U9"]]),
  users: new Map([
    ["opencode", "U0CL1267LK1"],
    ["jon", "U03PVTW5MU0"],
  ]),
};

const report: Report = {
  id: "fb_3f9a2c71",
  kind: "codebase",
  summary: "Guide links to a renamed file",
  details: "The guide links to a file that no longer exists.",
  resolution: "- Update the link.",
  context: {
    directory: "~/dev/app",
    repo: { name: "acme/app", url: "https://github.com/acme/app" },
    branch: "main",
    title: "Fix docs",
    sessionID: "ses_123",
  },
};

describe("toMrkdwn", () => {
  it("links known channels and people", () => {
    expect(toMrkdwn("Posted in #jons-agent by @OpenCode and @jon.", directory)).toBe(
      "Posted in <#C0CLJ57Q4U9> by <@U0CL1267LK1> and <@U03PVTW5MU0>.",
    );
  });

  it("leaves unknown names, emails, packages and issue numbers alone", () => {
    const text = "Email jon@seneca.io, package @opencode/plugin, issue #123, #unknown and @nobody.";
    expect(toMrkdwn(text, directory)).toBe(text);
  });

  it("converts markdown bold, headings, links and bullets", () => {
    expect(toMrkdwn("## Heading\n**bold** [docs](https://x.y/z)\n- one\n  * two", directory)).toBe(
      "*Heading*\n*bold* <https://x.y/z|docs>\n• one\n  • two",
    );
  });

  it("escapes Slack control characters but leaves code unconverted", () => {
    expect(toMrkdwn("a & <b> `#jons-agent **x** <y>`", directory)).toBe(
      "a &amp; &lt;b&gt; `#jons-agent **x** &lt;y&gt;`",
    );
  });
});

describe("hasPotentialMentions", () => {
  it.each([
    ["see #jons-agent", true],
    ["ask @jon", true],
    ["(@jon)", true],
    ["jon@seneca.io", false],
    ["no mentions", false],
  ])("%s → %s", (text, expected) => {
    expect(hasPotentialMentions(text)).toBe(expected);
  });
});

describe("composeReportMessages", () => {
  it("puts the title, ID and context in the channel post", () => {
    const { parent } = composeReportMessages(report, EMPTY_SLACK_DIRECTORY);
    expect(parent.text).toBe("[fb_3f9a2c71] codebase: Guide links to a renamed file");
    expect(parent.blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Guide links to a renamed file*  `fb_3f9a2c71`",
        },
      },
    ]);
    expect(JSON.stringify(parent.attachments)).toContain("<https://github.com/acme/app|acme/app>");
    expect(JSON.stringify(parent.attachments)).toContain("`main`");
  });

  it("falls back to the directory when there is no repo", () => {
    const { parent } = composeReportMessages(
      { ...report, context: { ...report.context, repo: undefined } },
      EMPTY_SLACK_DIRECTORY,
    );
    expect(JSON.stringify(parent.attachments)).toContain("`~/dev/app`");
  });

  it("puts the details, evidence and fix in the thread reply", () => {
    const { reply } = composeReportMessages(
      { ...report, evidence: "docs/guide.md:221" },
      EMPTY_SLACK_DIRECTORY,
    );
    expect(reply.blocks.map((block) => block.type)).toEqual(["section", "rich_text", "section"]);
    expect(JSON.stringify(reply.blocks)).toContain("docs/guide.md:221");
    expect(JSON.stringify(reply.blocks)).toContain("• Update the link.");
  });

  it("leaves out the evidence block when there is no evidence", () => {
    const { reply } = composeReportMessages(report, EMPTY_SLACK_DIRECTORY);
    expect(reply.blocks.map((block) => block.type)).toEqual(["section", "section"]);
  });

  it("shortens a long summary", () => {
    const { parent } = composeReportMessages({ ...report, summary: "x".repeat(400) }, EMPTY_SLACK_DIRECTORY);
    expect(JSON.stringify(parent.blocks)).toContain(`${"x".repeat(149)}…`);
  });
});
