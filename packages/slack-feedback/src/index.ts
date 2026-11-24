import { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { composeReportMessages, hasPotentialMentions, reportKindSchema } from "./message.ts";
import {
  callSlackApi,
  EMPTY_SLACK_DIRECTORY,
  fetchSlackDirectory,
  readKeychainPassword,
  readOriginRepo,
  slackSuccessSchema,
} from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

const optionsSchema = z.object({
  channel: z.string(),
  keychainService: z.string().default("opencode-slack-feedback"),
});
const messageResponseSchema = z.object({ ts: z.string() });

const inputSchema = z.object({
  kind: reportKindSchema,
  summary: z.string(),
  details: z.string(),
  resolution: z.string(),
  evidence: z.string().optional(),
});

function generateReportID() {
  return `fb_${randomUUID().slice(0, 8)}`;
}

const DESCRIPTION = `Report friction you hit while working, so a human can fix the root cause later, in a separate piece of work.

Only report what falls outside the current task. If you can fix the problem now as part of the task, with a small change that belongs in it, fix it and do not report it. Report it when fixing it would take you off the task, grow its scope, or touch code the task is not about.

Only report problems the user can fix themselves: code, docs, scripts, tests and config in the repository you are working in, the user's instructions, and their personal agent config (such as AGENTS.md, skills, and the config files in ~/.config). Do not report problems in things they do not own: the agent harness itself, third-party packages and libraries, external CLIs and services, MCP servers they did not write, or the operating system. If the only fix is upstream, do not report it.

Call this, without asking first, when:
- the user's instructions were ambiguous, contradictory, or missing something you needed (kind: prompt)
- the codebase misled you: wrong or stale docs/comments, surprising conventions, hidden coupling, hard-to-find code (kind: codebase)
- a script, test, task or tool defined in the repository or the user's config failed, was flaky, or behaved unexpectedly (kind: tooling)
- the repository's setup got in the way: missing env vars, wrong permissions, services it needs not running or not documented (kind: environment)

Another agent picks the report up later with no other context, so make it self-contained and succinct: name the files, commands and errors involved, not "the file above".

Report each distinct problem once per session. Do not report bugs you are asked to fix, problems you fixed during the task, or problems you caused yourself.
Keep working on the task after reporting. The result gives the report's ID (fb_...); mention it to the user.`;

export default Plugin.define({
  id: "slack-feedback",
  async setup(ctx) {
    const { channel, keychainService } = optionsSchema.parse(ctx.options);

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "give_feedback",
        description: DESCRIPTION,
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: reportKindSchema.options },
            summary: {
              type: "string",
              description: "One line, plain text: what went wrong.",
            },
            details: {
              type: "string",
              description:
                "Markdown, 2-4 sentences. What happened and what you tried. Write people as @name and Slack channels as #name.",
            },
            resolution: {
              type: "string",
              description:
                "Markdown, 1-3 short bullets. How to fix the root cause so it does not happen again: what to change, and where (file, doc, config or prompt). Say when you are unsure.",
            },
            evidence: {
              type: "string",
              description: "Optional plain text: file paths with line numbers, commands, or error output.",
            },
          },
          required: ["kind", "summary", "details", "resolution"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (raw, context) => {
          const input = inputSchema.parse(raw);
          const [token, session, vcs, repo] = await Promise.all([
            readKeychainPassword(keychainService),
            ctx.session.get({ sessionID: context.sessionID }),
            ctx.vcs.get().catch(() => undefined),
            readOriginRepo(ctx.location.directory),
          ]);
          const slackDirectory = hasPotentialMentions(`${input.details}\n${input.resolution}`)
            ? await fetchSlackDirectory(token)
            : EMPTY_SLACK_DIRECTORY;
          const id = generateReportID();
          const messages = composeReportMessages(
            {
              id,
              ...input,
              context: {
                directory: ctx.location.directory.replace(homedir(), "~"),
                repo,
                branch: vcs?.data.branch.current,
                title: session.title,
                sessionID: context.sessionID,
              },
            },
            slackDirectory,
          );
          const parent = await callSlackApi(
            "chat.postMessage",
            token,
            {
              channel,
              ...messages.parent,
              unfurl_links: false,
              unfurl_media: false,
            },
            messageResponseSchema,
            context.signal,
          );
          await callSlackApi(
            "chat.postMessage",
            token,
            {
              channel,
              thread_ts: parent.ts,
              ...messages.reply,
              unfurl_links: false,
              unfurl_media: false,
            },
            slackSuccessSchema,
            context.signal,
          );
          return { content: `Feedback ${id} posted. Continue with the task.` };
        },
      });
    });
  },
});
