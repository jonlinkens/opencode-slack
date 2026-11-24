import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { Repo } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

function nestedText(value: string | string[]) {
  return Array.isArray(value) ? value : [];
}

const textFieldsSchema: z.ZodType<string | string[], z.input<z.ZodJSONSchema>> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(textFieldsSchema).transform((items) => items.flatMap(nestedText)),
    z
      .record(z.string(), textFieldsSchema)
      .transform((fields) =>
        Object.entries(fields).flatMap(([key, value]) =>
          key === "text" ? [value].flat() : nestedText(value),
        ),
      ),
    z.union([z.number(), z.boolean(), z.null()]).transform(() => []),
  ]),
);
const textPartsSchema = z.array(textFieldsSchema).transform((items) => items.flatMap(nestedText));
const messageItemsSchema = z.array(z.json());
const slackMessageSchema = z.object({
  ts: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  blocks: messageItemsSchema.optional(),
  attachments: messageItemsSchema.optional(),
});

export type ReportContext = {
  id?: string;
  repo?: Repo;
  directory?: string;
  branch?: string;
};

function formatMessageText(message: z.output<typeof slackMessageSchema>) {
  const textParts = textPartsSchema.parse([...(message.blocks ?? []), ...(message.attachments ?? [])]);
  return textParts.length > 0 ? textParts.join("\n") : (message.text ?? "");
}

export function extractMessageText(message: z.input<typeof slackMessageSchema>) {
  return formatMessageText(slackMessageSchema.parse(message));
}

export const slackRepliesSchema = z.object({
  messages: z.array(
    slackMessageSchema.transform((message) => ({
      ts: message.ts,
      user: message.user,
      botID: message.bot_id,
      rawText: message.text ?? "",
      text: formatMessageText(message),
      blocks: message.blocks,
      attachments: message.attachments,
    })),
  ),
});

type ThreadMessage = z.output<typeof slackRepliesSchema>["messages"][number];

export function chooseSessionStatusTarget(
  parent: ThreadMessage | undefined,
  botUserID: string,
  botID: string | undefined,
): "edit" | "reply" {
  return parent && (parent.user === botUserID || (botID && parent.botID === botID)) ? "edit" : "reply";
}

export function composeSessionStartLine(
  location: "Rex" | "OpenCode",
  label: string,
  directory: string,
  worktreeBranch?: string,
) {
  const line = `:rocket: Started work on this in ${location}: \`${label}\``;
  if (!worktreeBranch) {
    return line;
  }
  const home = homedir();
  const path = directory.startsWith(`${home}${sep}`) ? `~${directory.slice(home.length)}` : directory;
  const escapedPath = path.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `${line} · worktree \`${worktreeBranch}\` (\`${escapedPath}\`)`;
}

const attachmentSchema = z.record(z.string(), z.json());
const sessionStartBlockSchema = z.object({
  type: z.literal("context"),
  elements: z.tuple([
    z.object({
      type: z.literal("mrkdwn"),
      text: z
        .string()
        .regex(
          /^(?:(?::rocket:|🚀) )?Started work on this in (?:Rex|OpenCode): `[^`]+`(?: · worktree `[^`]+` \(`.+`\))?$/,
        ),
    }),
  ]),
});

function keepOtherBlock(block: z.output<z.ZodJSONSchema>) {
  return !sessionStartBlockSchema.safeParse(block).success;
}

type MessageItems = z.output<typeof messageItemsSchema>;

export function composeSessionStartBlocks(
  blocks: MessageItems | undefined,
  attachments: MessageItems | undefined,
  line: string,
) {
  const startBlock = { type: "context", elements: [{ type: "mrkdwn", text: line }] };
  const attachmentIndex = attachments?.findIndex(function (attachment) {
    return attachmentSchema.safeParse(attachment).success;
  });
  if (attachmentIndex === undefined || attachmentIndex === -1) {
    return { blocks: [...(blocks ?? []).filter(keepOtherBlock), startBlock], attachments };
  }
  return {
    blocks: blocks?.filter(keepOtherBlock),
    attachments: attachments?.map(function (attachment, index) {
      const parsed = attachmentSchema.safeParse(attachment);
      if (!parsed.success) {
        return attachment;
      }
      const previousBlocks = Array.isArray(parsed.data.blocks) ? parsed.data.blocks : undefined;
      if (index === attachmentIndex) {
        return { ...parsed.data, blocks: [...(previousBlocks ?? []).filter(keepOtherBlock), startBlock] };
      }
      return previousBlocks ? { ...parsed.data, blocks: previousBlocks.filter(keepOtherBlock) } : attachment;
    }),
  };
}

export function removeBotMention(text: string, botUserID: string) {
  return text.replaceAll(`<@${botUserID}>`, "").trim();
}

export function parseReportContext(texts: readonly string[]): ReportContext {
  const threadText = texts.join("\n");
  const id = threadText.match(/\bfb_[0-9a-f]{8}\b/)?.[0];
  const repoMatch = threadText.match(/:package: <(https:\/\/[^|>]+)\|([^>]+)>/);
  const directoryMatch = threadText.match(/:file_folder: `([^`]+)`/);
  const branch = id
    ? threadText.match(
        /^(?::package: <[^>\n]+>|:file_folder: `[^\n]+?`)  ·  :twisted_rightwards_arrows: `(\S+)`(?=  ·  |$)/m,
      )?.[1]
    : undefined;
  return {
    id,
    repo: repoMatch ? { url: repoMatch[1], name: repoMatch[2] } : undefined,
    directory: directoryMatch?.[1],
    branch: branch?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  };
}

export function shortenThreadTimestamp(threadTimestamp: string) {
  return threadTimestamp.replace(".", "").slice(-9);
}

export function composeSessionLabel(report: ReportContext, threadTimestamp: string, directory: string) {
  const folder = basename(directory).replace(/[^a-z0-9_-]+/gi, "-") || "slack";
  return report.id ? report.id.replace("_", "-") : `${folder}-${shortenThreadTimestamp(threadTimestamp)}`;
}

export function composeSessionTitle(report: ReportContext, request: string) {
  const summary = request.replace(/\s+/g, " ").trim() || "thread";
  return `${report.id ?? "Slack"}: ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary}`;
}

export type PromptInput = {
  request: string;
  requester: string;
  channel: string;
  threadTimestamp: string;
  thread: readonly { author: string; text: string }[];
  checkoutExplanation: string;
};

export function composeSessionPrompt({
  request,
  requester,
  channel,
  threadTimestamp,
  thread,
  checkoutExplanation,
}: PromptInput) {
  return [
    `<@${requester}> started this session from a Slack thread (channel ${channel}, thread_ts ${threadTimestamp}).`,
    "",
    checkoutExplanation,
    "",
    request ? "Their request:" : "The mention did not add a request. Use the earlier request in the thread.",
    ...(request ? [request] : []),
    "",
    "The thread so far:",
    ...thread.map(({ author, text }) => `--- ${author} ---\n${text}`),
    "",
    "Work in this directory. Do not post in the Slack thread: reactions on the mention already show your progress. Report back here.",
  ].join("\n");
}

export function composeFollowUpPrompt(requester: string, request: string) {
  return `Slack follow-up from <@${requester}>:\n${request || "(no message text)"}`;
}
