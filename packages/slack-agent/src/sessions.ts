import { z } from "zod";

const slackThreadSchema = z.object({ slackChannel: z.string(), slackThreadTs: z.string() });
const sessionPageSchema = z.object({
  data: z.array(z.object({ id: z.string(), metadata: z.json().optional() })),
  cursor: z.object({ next: z.string().nullish() }),
});
const sessionNotFoundSchema = z.object({ _tag: z.literal("SessionNotFoundError"), sessionID: z.string() });

type SlackThread = z.infer<typeof slackThreadSchema>;
type SessionPage = z.input<typeof sessionPageSchema>;
type ListSessions = (input: { parentID?: null; cursor?: string }) => Promise<SessionPage>;

export async function findThreadSession(thread: SlackThread, listSessions: ListSessions) {
  let input: Parameters<ListSessions>[0] = { parentID: null };
  for (;;) {
    const { data, cursor } = sessionPageSchema.parse(await listSessions(input));
    const session = data.find(({ metadata }) => {
      const match = slackThreadSchema.safeParse(metadata);
      return (
        match.success &&
        match.data.slackChannel === thread.slackChannel &&
        match.data.slackThreadTs === thread.slackThreadTs
      );
    });
    if (session || !cursor.next) {
      return session?.id;
    }
    input = { cursor: cursor.next };
  }
}

export async function sendThreadFollowUp(
  sessionID: string,
  text: string,
  prompt: (input: { sessionID: string; text: string; delivery: "queue" }) => Promise<void>,
) {
  try {
    await prompt({ sessionID, text, delivery: "queue" });
    return true;
  } catch (error) {
    const missing = sessionNotFoundSchema.safeParse(error);
    if (missing.success && missing.data.sessionID === sessionID) {
      return false;
    }
    throw error;
  }
}

const activeThreads = new Map<string, Promise<void>>();

export async function runInThreadOrder(
  { slackChannel, slackThreadTs }: SlackThread,
  handle: () => Promise<void>,
) {
  const key = `${slackChannel}:${slackThreadTs}`;
  const pending = activeThreads.get(key);
  const next = pending ? pending.then(handle, handle) : handle();
  activeThreads.set(key, next);
  try {
    await next;
  } finally {
    if (activeThreads.get(key) === next) {
      activeThreads.delete(key);
    }
  }
}
