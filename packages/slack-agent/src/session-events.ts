import type { Plugin } from "@opencode/plugin";
import { z } from "zod";

import type { createMentionReaction } from "./reactions.ts";

const inboxData = z.object({ sessionID: z.string(), inboxID: z.string() });
const sessionData = z.object({ sessionID: z.string() });
const requestData = sessionData.extend({ id: z.string() });
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.inbox.delivered"), data: inboxData }),
  z.object({ type: z.literal("session.inbox.cancelled"), data: inboxData }),
  z.object({ type: z.literal("session.execution.succeeded"), data: sessionData }),
  z.object({ type: z.literal("session.execution.failed"), data: sessionData }),
  z.object({ type: z.literal("session.execution.interrupted"), data: sessionData }),
  z.object({ type: z.literal("session.deleted"), data: sessionData }),
  z.object({ type: z.literal("permission.asked"), data: requestData }),
  z.object({ type: z.literal("permission.replied"), data: sessionData.extend({ requestID: z.string() }) }),
  z.object({ type: z.literal("form.created"), data: z.object({ form: requestData }) }),
  z.object({ type: z.literal("form.replied"), data: requestData }),
  z.object({ type: z.literal("form.cancelled"), data: requestData }),
]);
type SessionEvent = z.output<typeof eventSchema>;
type Subscribe = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]["event"]["subscribe"];
type UpdateReaction = ReturnType<typeof createMentionReaction>;
type MentionState = {
  inboxID: string;
  phase: "queued" | "running" | "finished";
  requests: ReadonlySet<string>;
};
type TrackedMention = { state: MentionState; updateReaction: UpdateReaction };

export function advanceMention(state: MentionState, event: SessionEvent): MentionState | "done" | "failed" {
  switch (event.type) {
    case "session.inbox.delivered":
      return event.data.inboxID === state.inboxID && state.phase === "queued"
        ? { ...state, phase: "running" }
        : state;
    case "session.inbox.cancelled":
      return event.data.inboxID === state.inboxID ? "failed" : state;
    case "session.execution.succeeded":
      if (state.phase !== "running") {
        return state;
      }
      return state.requests.size === 0 ? "done" : { ...state, phase: "finished" };
    case "session.execution.failed":
    case "session.execution.interrupted":
      return state.phase === "running" ? "failed" : state;
    case "session.deleted":
      return "failed";
    case "permission.asked":
    case "form.created":
      if (state.phase !== "running") {
        return state;
      }
      return {
        ...state,
        requests: new Set([
          ...state.requests,
          event.type === "form.created" ? event.data.form.id : event.data.id,
        ]),
      };
    case "permission.replied":
    case "form.replied":
    case "form.cancelled": {
      const id = event.type === "permission.replied" ? event.data.requestID : event.data.id;
      if (!state.requests.has(id)) {
        return state;
      }
      const requests = new Set(state.requests);
      requests.delete(id);
      return state.phase === "finished" && requests.size === 0 ? "done" : { ...state, requests };
    }
  }
}

export function getMentionReaction(state: ReturnType<typeof advanceMention>) {
  if (state === "done") {
    return "white_check_mark";
  }
  if (state === "failed") {
    return "x";
  }
  return state.requests.size > 0 ? "raised_hand" : "eyes";
}

type SharedSessionEvents = {
  mentions: Map<string, Map<string, TrackedMention>>;
  subscribers: Map<AbortController, Subscribe>;
};
declare global {
  var __opencodeSlackSessionEvents: SharedSessionEvents | undefined;
}
const shared: SharedSessionEvents = (globalThis.__opencodeSlackSessionEvents ??= {
  mentions: new Map(),
  subscribers: new Map(),
});

export function trackMention(sessionID: string, inboxID: string, updateReaction: UpdateReaction) {
  const mentions = shared.mentions.get(sessionID) ?? new Map<string, TrackedMention>();
  shared.mentions.set(sessionID, mentions);
  mentions.set(inboxID, { state: { inboxID, phase: "queued", requests: new Set() }, updateReaction });
  return function forgetMention() {
    mentions.delete(inboxID);
    if (mentions.size === 0 && shared.mentions.get(sessionID) === mentions) {
      shared.mentions.delete(sessionID);
    }
  };
}

function handleSessionEvent(event: SessionEvent) {
  const sessionID = event.type === "form.created" ? event.data.form.sessionID : event.data.sessionID;
  const mentions = shared.mentions.get(sessionID);
  if (!mentions) {
    return;
  }
  for (const [id, mention] of mentions) {
    const next = advanceMention(mention.state, event);
    if (next === "done" || next === "failed") {
      mentions.delete(id);
    } else {
      mention.state = next;
    }
    mention.updateReaction(getMentionReaction(next));
  }
  if (mentions.size === 0) {
    shared.mentions.delete(sessionID);
  }
}

async function watchSessionEvents(subscribe: Subscribe, signal: AbortSignal) {
  const types = eventSchema.options.map(function (option) {
    return option.shape.type.value;
  });
  for await (const event of subscribe({ signal, types })) {
    if (signal.aborted) {
      return;
    }
    handleSessionEvent(eventSchema.parse(event));
  }
}

function startWatching(controller: AbortController, subscribe: Subscribe) {
  watchSessionEvents(subscribe, controller.signal).catch(function (error) {
    if (!controller.signal.aborted) {
      console.error("[slack-agent] OpenCode event stream failed", error);
    }
  });
}

export function listenForSessionEvents(subscribe: Subscribe) {
  const controller = new AbortController();
  shared.subscribers.set(controller, subscribe);
  if (shared.subscribers.size === 1) {
    startWatching(controller, subscribe);
  }
  return function stopListening() {
    const owner = shared.subscribers.keys().next().value;
    shared.subscribers.delete(controller);
    controller.abort();
    if (owner !== controller) {
      return;
    }
    const next = shared.subscribers.entries().next().value;
    if (next) {
      startWatching(...next);
    }
  };
}
