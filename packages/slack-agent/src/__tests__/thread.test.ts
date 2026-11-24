import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  chooseSessionStatusTarget,
  composeFollowUpPrompt,
  composeSessionLabel,
  composeSessionPrompt,
  composeSessionStartBlocks,
  composeSessionStartLine,
  composeSessionTitle,
  extractMessageText,
  parseReportContext,
  removeBotMention,
  slackRepliesSchema,
} from "../thread.ts";

const parent = {
  ts: "1795519349.359759",
  bot_id: "B1",
  text: "[fb_2f94595f] tooling: Guide links to a renamed file",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Guide links to a renamed file*  `fb_2f94595f`",
      },
    },
  ],
  attachments: [
    {
      color: "#7c5cff",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":package: <https://github.com/acme/app|acme/app>  ·  :twisted_rightwards_arrows: `main`",
            },
          ],
        },
      ],
    },
  ],
};

describe("extractMessageText", () => {
  it("reads blocks and attachments instead of the fallback text", () => {
    expect(extractMessageText(parent)).toBe(
      "*Guide links to a renamed file*  `fb_2f94595f`\n:package: <https://github.com/acme/app|acme/app>  ·  :twisted_rightwards_arrows: `main`",
    );
  });

  it("uses the plain text when a message has no blocks", () => {
    expect(extractMessageText({ ts: "1", text: "hello" })).toBe("hello");
  });

  it("keeps nested text in order and ignores other fields in a Slack reply", () => {
    const messages = [
      {
        ts: "1",
        text: "fallback",
        blocks: [{ label: "ignored", text: ["ignored", { text: "nested" }], elements: [null, 0, true] }],
        attachments: [{ text: "attachment" }],
      },
    ];
    expect(slackRepliesSchema.parse({ messages }).messages[0]).toMatchObject({
      rawText: "fallback",
      text: "nested\nattachment",
      blocks: messages[0].blocks,
      attachments: messages[0].attachments,
    });
  });
});

describe("composeSessionStartBlocks", function () {
  const line = ":rocket: Started work on this in Rex: `fb-2f94595f`";
  const status = { type: "context", elements: [{ type: "mrkdwn", text: line }] };

  it("appends the status to the report attachment and keeps the other blocks", function () {
    const otherAttachment = { text: "More context" };
    const attachments = [...parent.attachments, otherAttachment];
    expect(composeSessionStartBlocks(parent.blocks, attachments, line)).toEqual({
      blocks: parent.blocks,
      attachments: [
        { ...parent.attachments[0], blocks: [...parent.attachments[0].blocks, status] },
        otherAttachment,
      ],
    });
  });

  it("replaces the previous session line without adding a duplicate", function () {
    const previous = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "🚀 Started work on this in OpenCode: `ses_old` · worktree `fb/2f94595f` (`/dev/app`)",
        },
      ],
    };
    const [attachment] = parent.attachments;
    const attachments = [{ ...attachment, blocks: [...attachment.blocks, previous] }];
    expect(composeSessionStartBlocks(parent.blocks, attachments, line)).toEqual({
      blocks: parent.blocks,
      attachments: [{ ...attachment, blocks: [...attachment.blocks, status] }],
    });
  });

  it("adds and replaces the line in top-level blocks when there is no attachment", function () {
    const updated = composeSessionStartBlocks(parent.blocks, undefined, line);
    expect(updated).toEqual({ blocks: [...parent.blocks, status], attachments: undefined });
    const newLine = ":rocket: Started work on this in OpenCode: `ses_new`";
    expect(composeSessionStartBlocks(updated.blocks, updated.attachments, newLine)).toEqual({
      blocks: [...parent.blocks, { type: "context", elements: [{ type: "mrkdwn", text: newLine }] }],
      attachments: undefined,
    });
  });
});

describe("chooseSessionStatusTarget", function () {
  it("edits only a parent posted by this bot", function () {
    const { messages } = slackRepliesSchema.parse({
      messages: [parent, { ts: "2", user: "U0BOT" }, { ts: "3", user: "U0JON", bot_id: "B2" }],
    });
    expect(chooseSessionStatusTarget(messages[0], "U0BOT", "B1")).toBe("edit");
    expect(chooseSessionStatusTarget(messages[1], "U0BOT", undefined)).toBe("edit");
    expect(chooseSessionStatusTarget(messages[2], "U0BOT", "B1")).toBe("reply");
    expect(chooseSessionStatusTarget(undefined, "U0BOT", "B1")).toBe("reply");
  });
});

describe("composeSessionStartLine", function () {
  it("keeps the in-place status and shows the directory for a worktree", function () {
    const directory = join(homedir(), "dev", "app.worktrees", "fb-2f94595f");
    expect(composeSessionStartLine("Rex", "fb-2f94595f", "/dev/app")).toBe(
      ":rocket: Started work on this in Rex: `fb-2f94595f`",
    );
    expect(composeSessionStartLine("OpenCode", "ses_new", directory, "fb/2f94595f")).toBe(
      ":rocket: Started work on this in OpenCode: `ses_new` · worktree `fb/2f94595f` (`~/dev/app.worktrees/fb-2f94595f`)",
    );
  });
});

describe("parseReportContext", () => {
  it("reads the ID, repo and branch from a report", () => {
    expect(parseReportContext([extractMessageText(parent)])).toEqual({
      id: "fb_2f94595f",
      repo: { name: "acme/app", url: "https://github.com/acme/app" },
      directory: undefined,
      branch: "main",
    });
  });

  it("decodes the branch from the report metadata", function () {
    const text =
      "`fb_2f94595f`\n:file_folder: `~/dev`  ·  :twisted_rightwards_arrows: `feature/a&amp;b`  ·  `ses_1`";
    expect(parseReportContext([text]).branch).toBe("feature/a&b");
    expect(parseReportContext([text.replace("`fb_2f94595f`\n", "")]).branch).toBeUndefined();
  });

  it("reads the directory when the report has no repo", () => {
    expect(parseReportContext([":file_folder: `~/dev`  ·  `ses_1`"]).directory).toBe("~/dev");
  });

  it("returns nothing for a thread that is not a report", () => {
    expect(parseReportContext(["just chatting"])).toEqual({
      id: undefined,
      repo: undefined,
      directory: undefined,
      branch: undefined,
    });
  });
});

describe("removeBotMention", () => {
  it("removes the bot mention", () => {
    expect(removeBotMention("<@U0BOT> fix this please", "U0BOT")).toBe("fix this please");
  });
});

describe("composeSessionLabel", () => {
  it("uses the report ID", () => {
    expect(composeSessionLabel({ id: "fb_2f94595f" }, "1.2", "/dev/app")).toBe("fb-2f94595f");
  });

  it("uses the checkout folder and a short thread timestamp otherwise", function () {
    expect(composeSessionLabel({}, "1795519349.359759", "/dev/senecaWeb")).toBe("senecaWeb-349359759");
  });
});

describe("composeSessionTitle", function () {
  it("normalizes request whitespace and keeps the report ID", function () {
    expect(composeSessionTitle({ id: "fb_2f94595f" }, "fix\n this")).toBe("fb_2f94595f: fix this");
  });
});

describe("composeSessionPrompt", () => {
  it("includes the request, where to reply and the thread", () => {
    const prompt = composeSessionPrompt({
      request: "fix this",
      requester: "U0JON",
      channel: "C0CHAN",
      threadTimestamp: "1.2",
      thread: [{ author: "OpenCode", text: "the report" }],
      checkoutExplanation: "You are in the checkout on branch `main`.",
    });
    expect(prompt).toContain("<@U0JON> started this session");
    expect(prompt).toContain("channel C0CHAN, thread_ts 1.2");
    expect(prompt).toContain("fix this");
    expect(prompt).toContain("--- OpenCode ---\nthe report");
    expect(prompt).toContain("You are in the checkout on branch `main`.");
  });

  it("says what to do when the mention has no message", () => {
    expect(
      composeSessionPrompt({
        request: "",
        requester: "U",
        channel: "C",
        threadTimestamp: "1",
        thread: [],
        checkoutExplanation: "You are in the checkout on branch `main`.",
      }),
    ).toContain("Use the earlier request in the thread.");
  });
});

describe("composeFollowUpPrompt", function () {
  it("includes who asked and their new request", function () {
    expect(composeFollowUpPrompt("U123", "also check logout")).toBe(
      "Slack follow-up from <@U123>:\nalso check logout",
    );
  });
});
