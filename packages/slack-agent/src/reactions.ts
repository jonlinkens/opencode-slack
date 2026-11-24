import { callSlackApi, slackSuccessSchema } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

type Reaction = "eyes" | "raised_hand" | "white_check_mark" | "x";
type ReactionMethod = "reactions.add" | "reactions.remove";
type ReactionChange = { method: ReactionMethod; name: Reaction };
type Message = { channel: string; ts: string };

const slackErrorSchema = z.object({ message: z.string() });
const unchangedErrors = {
  "reactions.add": "already_reacted",
  "reactions.remove": "no_reaction",
};

export function planReactionChange(previous: Reaction | undefined, next: Reaction): ReactionChange[] {
  if (previous === next) {
    return [];
  }
  return [
    ...(previous ? [{ method: "reactions.remove", name: previous } satisfies ReactionChange] : []),
    { method: "reactions.add", name: next },
  ];
}

export async function writeReaction(
  token: string,
  message: Message,
  { method, name }: ReactionChange,
  call: typeof callSlackApi<z.output<typeof slackSuccessSchema>> = callSlackApi,
) {
  try {
    await call(method, token, { channel: message.channel, timestamp: message.ts, name }, slackSuccessSchema);
  } catch (error) {
    const response = slackErrorSchema.safeParse(error);
    if (!response.success || response.data.message !== `Slack ${method} failed: ${unchangedErrors[method]}`) {
      throw error;
    }
  }
}

export function createMentionReaction(write: (change: ReactionChange) => Promise<void>) {
  let reaction: Reaction | undefined;
  let pending = Promise.resolve();
  return function updateReaction(next: Reaction) {
    const changes = planReactionChange(reaction, next);
    reaction = next;
    for (const change of changes) {
      pending = pending.then(() =>
        write(change).catch(function (error) {
          console.error("[slack-agent] Reaction update failed", error);
        }),
      );
    }
    return pending;
  };
}
