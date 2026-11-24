import { callSlackApi } from "@jonlinkens/opencode-slack-shared";
import { z } from "zod";

const mentionEventSchema = z.object({
  type: z.literal("app_mention"),
  user: z.string(),
  text: z.string(),
  channel: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
});
const mentionPayloadSchema = z.object({ event_id: z.string(), event: mentionEventSchema });
const envelopeSchema = z.object({
  type: z.string(),
  envelope_id: z.string().optional(),
  payload: mentionPayloadSchema.optional().catch(undefined),
});
const connectionResponseSchema = z.object({ url: z.string() });

export type MentionEvent = z.infer<typeof mentionEventSchema>;

type MentionHandler = (event: MentionEvent) => Promise<void>;

function startSocketConnection(readAppToken: () => Promise<string>, onMention: MentionHandler) {
  let socket: WebSocket | undefined;
  let socketOpenTimer: ReturnType<typeof setTimeout> | undefined;
  let isStopped = false;
  const seenEventIDs = new Set<string>();

  function scheduleSocketOpen(delay: number) {
    if (isStopped) {
      return;
    }
    socketOpenTimer = setTimeout(async () => {
      try {
        await openSocket();
      } catch (error) {
        console.error("[slack-agent] Socket Mode connection failed", error);
        scheduleSocketOpen(60_000);
      }
    }, delay);
  }

  async function openSocket() {
    const { url } = await callSlackApi(
      "apps.connections.open",
      await readAppToken(),
      {},
      connectionResponseSchema,
    );
    if (isStopped) {
      return;
    }
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.onclose = () => {
      if (socket === nextSocket) {
        scheduleSocketOpen(1_000);
      }
    };
    nextSocket.onmessage = async (message) => {
      const envelope = envelopeSchema.parse(JSON.parse(String(message.data)));
      if (envelope.envelope_id) {
        nextSocket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
      if (envelope.type === "disconnect") {
        nextSocket.close();
      }
      if (envelope.type !== "events_api" || !envelope.payload) {
        return;
      }
      const { event_id, event } = envelope.payload;
      if (seenEventIDs.has(event_id)) {
        return;
      }
      seenEventIDs.add(event_id);
      try {
        await onMention(event);
      } catch (error) {
        console.error("[slack-agent] Mention handling failed", error);
      }
    };
  }

  scheduleSocketOpen(0);
  return () => {
    isStopped = true;
    clearTimeout(socketOpenTimer);
    socket?.close();
  };
}

const MODULE_ID = crypto.randomUUID();

type Shared = {
  handlers: Map<symbol, MentionHandler>;
  connection?: { module: string; stop: () => void };
};
declare global {
  var __opencodeSlackAgent: Shared | undefined;
}
const shared: Shared = (globalThis.__opencodeSlackAgent ??= { handlers: new Map() });

async function dispatchMention(event: MentionEvent): Promise<void> {
  const handler = [...shared.handlers.values()].at(-1);
  if (handler) {
    await handler(event);
  }
}

export function listenForMentions(readAppToken: () => Promise<string>, handler: MentionHandler) {
  const instance = Symbol("slack-agent");
  shared.handlers.set(instance, handler);
  if (shared.connection?.module !== MODULE_ID) {
    shared.connection?.stop();
    shared.connection = {
      module: MODULE_ID,
      stop: startSocketConnection(readAppToken, dispatchMention),
    };
  }
  return () => {
    shared.handlers.delete(instance);
    if (shared.handlers.size > 0) {
      return;
    }
    shared.connection?.stop();
    shared.connection = undefined;
  };
}
