import { Plugin } from "@opencode/plugin";
import { callSlackApi, readKeychainPassword, slackSuccessSchema } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

import {
  chooseCheckout,
  composeCheckoutReply,
  discoverCheckouts,
  isRepoOnlyMessage,
  parseRepoReference,
  resolveExistingDirectory,
} from "./checkout.ts";
import { createMentionReaction, writeReaction } from "./reactions.ts";
import { openSessionInRex } from "./rex.ts";
import { listenForSessionEvents, trackMention } from "./session-events.ts";
import { findThreadSession, runInThreadOrder, sendThreadFollowUp } from "./sessions.ts";
import { listenForMentions, type MentionEvent } from "./socket.ts";
import {
  chooseSessionStatusTarget,
  composeFollowUpPrompt,
  composeSessionLabel,
  composeSessionPrompt,
  composeSessionStartBlocks,
  composeSessionStartLine,
  composeSessionTitle,
  parseReportContext,
  removeBotMention,
  slackRepliesSchema,
} from "./thread.ts";
import { prepareSessionCheckout, worktreesOptionSchema } from "./worktree.ts";

const optionsSchema = z.object({
  allowedUsers: z.array(z.string()),
  channels: z.array(z.string()).default([]),
  roots: z.array(z.string()).default(["~/dev"]),
  repos: z.record(z.string(), z.string()).default({}),
  worktrees: worktreesOptionSchema,
  rex: z.boolean().default(true),
  rexFocus: z.boolean().default(false),
  botKeychainService: z.string().default("opencode-slack-feedback"),
  appKeychainService: z.string().default("opencode-slack-agent-app"),
});
const authTestResponseSchema = z.object({ user_id: z.string(), bot_id: z.string().optional() });

export default Plugin.define({
  id: "slack-agent",
  setup(ctx) {
    const options = optionsSchema.parse(ctx.options);
    function readBotToken() {
      return readKeychainPassword(options.botKeychainService);
    }
    let botIdentity: z.infer<typeof authTestResponseSchema> | undefined;

    async function postThreadReply(
      token: string,
      event: MentionEvent,
      threadTimestamp: string,
      text: string,
    ) {
      await callSlackApi(
        "chat.postMessage",
        token,
        {
          channel: event.channel,
          thread_ts: threadTimestamp,
          text,
          unfurl_links: false,
        },
        slackSuccessSchema,
      );
    }

    async function handleMention(event: MentionEvent, token: string, threadTimestamp: string) {
      const updateReaction = createMentionReaction(function (change) {
        return writeReaction(token, event, change);
      });
      const inboxID = `msg_${crypto.randomUUID()}`;
      let forgetMention: (() => void) | undefined;
      try {
        await routeMention();
      } catch (error) {
        forgetMention?.();
        const reason = String(error).split("\n")[0].slice(0, 250);
        await Promise.all([
          updateReaction("x"),
          postThreadReply(token, event, threadTimestamp, `Couldn't handle the mention: ${reason}`),
        ]);
      }

      async function routeMention() {
        botIdentity ??= await callSlackApi("auth.test", token, {}, authTestResponseSchema);
        const botMention = `<@${botIdentity.user_id}>`;
        const request = removeBotMention(event.text, botIdentity.user_id);
        const metadata = { slackChannel: event.channel, slackThreadTs: threadTimestamp };
        const sessionID = await findThreadSession(metadata, ctx.session.list);
        if (sessionID) {
          updateReaction("eyes");
          forgetMention = trackMention(sessionID, inboxID, updateReaction);
          const sent = await sendThreadFollowUp(
            sessionID,
            composeFollowUpPrompt(event.user, request),
            async function (input) {
              await ctx.session.prompt({ ...input, id: inboxID });
            },
          );
          if (sent) {
            return;
          }
          forgetMention();
        }

        const [{ messages }, checkouts] = await Promise.all([
          callSlackApi(
            "conversations.replies",
            token,
            { channel: event.channel, ts: threadTimestamp, limit: 100 },
            slackRepliesSchema,
          ),
          discoverCheckouts(options),
        ]);

        const previousMessages = messages.filter((message) => message.ts < event.ts);
        const botUserID = botIdentity.user_id;
        const botID = botIdentity.bot_id;
        const parent = messages.find((message) => message.ts === threadTimestamp);
        const statusTarget = chooseSessionStatusTarget(parent, botUserID, botID);
        const report = parseReportContext(parent && statusTarget === "edit" ? [parent.text] : []);
        const earlierMentions = previousMessages
          .flatMap((message) =>
            !message.botID &&
            message.user &&
            options.allowedUsers.includes(message.user) &&
            message.rawText.includes(botMention)
              ? [removeBotMention(message.rawText, botUserID)]
              : [],
          )
          .reverse();
        const choice = chooseCheckout(request, earlierMentions, report, checkouts);
        const checkout = choice.directory ? await resolveExistingDirectory(choice.directory) : undefined;

        if (!checkout) {
          await Promise.all([
            updateReaction("raised_hand"),
            postThreadReply(token, event, threadTimestamp, composeCheckoutReply(checkouts, choice.name)),
          ]);
          return;
        }

        updateReaction("eyes");
        const { directory, explanation, worktreeBranch } = await prepareSessionCheckout(
          checkout,
          report,
          threadTimestamp,
          options.worktrees,
        );

        const sessionRequest = choice.isRepoOnly ? "" : request;

        const earlierRequest = previousMessages.find((message) => {
          if (!message.user || message.botID || message.user === botUserID) {
            return false;
          }
          const text = removeBotMention(message.rawText, botUserID);
          if (!text) {
            return false;
          }
          if (!message.rawText.includes(botMention)) {
            return true;
          }
          const reference = parseRepoReference(text, checkouts);
          return !reference || !isRepoOnlyMessage(text, reference.token);
        });

        const session = await ctx.session.create({
          title: composeSessionTitle(
            report,
            sessionRequest || earlierRequest?.rawText.replaceAll(botMention, "") || "",
          ),
          location: { directory },
          metadata,
        });

        forgetMention = trackMention(session.id, inboxID, updateReaction);

        await ctx.session.prompt({
          sessionID: session.id,
          id: inboxID,
          text: composeSessionPrompt({
            request: sessionRequest,
            requester: event.user,
            channel: event.channel,
            threadTimestamp,
            checkoutExplanation: explanation,
            thread: previousMessages.map((message) => ({
              author: message.user && !message.botID ? `<@${message.user}>` : "Bot",
              text: message.text,
            })),
          }),
        });

        const label = composeSessionLabel(report, threadTimestamp, checkout);

        if (options.rex) {
          await openSessionInRex({
            label,
            directory,
            sessionID: session.id,
            shouldFocus: options.rexFocus,
          });
        }

        const line = composeSessionStartLine(
          options.rex ? "Rex" : "OpenCode",
          options.rex ? label : session.id,
          directory,
          worktreeBranch,
        );

        await publishSessionStatus().catch(function (error) {
          console.error("[slack-agent] Session status update failed", error);
        });

        async function publishSessionStatus() {
          if (!parent || statusTarget === "reply") {
            await postThreadReply(token, event, threadTimestamp, line);
            return;
          }
          await callSlackApi(
            "chat.update",
            token,
            {
              channel: event.channel,
              ts: parent.ts,
              text: parent.rawText,
              ...composeSessionStartBlocks(parent.blocks, parent.attachments, line),
            },
            slackSuccessSchema,
          );
        }
      }
    }

    const stopEvents = listenForSessionEvents(ctx.event.subscribe);
    const stopMentions = listenForMentions(
      () => readKeychainPassword(options.appKeychainService),
      async (event) => {
        if (!options.allowedUsers.includes(event.user)) {
          return;
        }
        if (options.channels.length > 0 && !options.channels.includes(event.channel)) {
          return;
        }
        const threadTimestamp = event.thread_ts ?? event.ts;
        await runInThreadOrder(
          { slackChannel: event.channel, slackThreadTs: threadTimestamp },
          async function () {
            const token = await readBotToken();
            await handleMention(event, token, threadTimestamp);
          },
        );
      },
    );
    return function stop() {
      stopMentions();
      stopEvents();
    };
  },
});
