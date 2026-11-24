import type { Directory } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

export const reportKindSchema = z.enum(["prompt", "codebase", "tooling", "environment"]);
type Kind = z.infer<typeof reportKindSchema>;

const MAX_TEXT_LENGTH = 2900;
const MAX_HEADER_LENGTH = 150;
const REPORT_COLOR = "#7c5cff";

type DetailBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | {
      type: "rich_text";
      elements: { type: "rich_text_preformatted"; elements: { type: "text"; text: string }[] }[];
    };

export type Report = {
  id: string;
  kind: Kind;
  summary: string;
  details: string;
  resolution: string;
  evidence?: string;
  context: {
    directory: string;
    repo?: { name: string; url: string };
    branch?: string;
    title?: string;
    sessionID: string;
  };
};

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeSlackText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function hasPotentialMentions(text: string) {
  return /(^|[\s(])[#@][\w]/.test(text);
}

function convertProseToMrkdwn(text: string, directory: Directory) {
  return escapeSlackText(text)
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/(^|[\s(])#([a-z0-9][\w-]*)(?![\w/-])/g, (match, lead: string, name: string) => {
      const id = directory.channels.get(name);
      return id ? `${lead}<#${id}>` : match;
    })
    .replace(/(^|[\s(])@([\w-]+(?:\.[\w-]+)*)(?![\w/-]|\.\w)/g, (match, lead: string, name: string) => {
      const id = directory.users.get(name.toLowerCase());
      return id ? `${lead}<@${id}>` : match;
    });
}

export function toMrkdwn(markdown: string, directory: Directory) {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? escapeSlackText(part) : convertProseToMrkdwn(part, directory)))
    .join("");
}

export function composeReportMessages(report: Report, directory: Directory) {
  const { context } = report;
  const metadata = [
    context.repo
      ? `:package: <${context.repo.url}|${escapeSlackText(context.repo.name)}>`
      : `:file_folder: \`${escapeSlackText(context.directory)}\``,
    context.branch ? `:twisted_rightwards_arrows: \`${escapeSlackText(context.branch)}\`` : undefined,
    context.title ? `:memo: ${escapeSlackText(context.title)}` : undefined,
    `\`${context.sessionID}\``,
  ].filter(Boolean);

  const header = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${escapeSlackText(truncateText(report.summary, MAX_HEADER_LENGTH))}*  \`${report.id}\``,
    },
  };

  const detailBlocks: DetailBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateText(toMrkdwn(report.details, directory), MAX_TEXT_LENGTH),
      },
    },
    ...(report.evidence
      ? ([
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_preformatted",
                elements: [{ type: "text", text: truncateText(report.evidence, MAX_TEXT_LENGTH) }],
              },
            ],
          },
        ] satisfies DetailBlock[])
      : []),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateText(
          `*:wrench: Suggested fix*\n${toMrkdwn(report.resolution, directory)}`,
          MAX_TEXT_LENGTH,
        ),
      },
    },
  ];

  return {
    parent: {
      text: `[${report.id}] ${report.kind}: ${report.summary}`,
      blocks: [header],
      attachments: [
        {
          color: REPORT_COLOR,
          blocks: [
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: metadata.join("  ·  ") }],
            },
          ],
        },
      ],
    },
    reply: { text: `Details for ${report.id}`, blocks: detailBlocks },
  };
}
