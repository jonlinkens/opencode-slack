import { describe, expect, it } from "vitest";

import { advanceMention, getMentionReaction, listenForSessionEvents } from "../session-events.ts";

const sessionID = "ses_thread";
const inboxID = "msg_mention";
type MentionState = Parameters<typeof advanceMention>[0];
const queued: MentionState = { inboxID, phase: "queued", requests: new Set() };
const delivered: MentionState = { ...queued, phase: "running" };

describe("mention lifecycle", function () {
  it("does not complete a follow-up until its own prompt is delivered", function () {
    const previousDelivery = advanceMention(queued, {
      type: "session.inbox.delivered",
      data: { sessionID, inboxID: "msg_previous" },
    });
    expect(previousDelivery).toBe(queued);
    expect(
      getMentionReaction(
        advanceMention(queued, { type: "session.execution.succeeded", data: { sessionID } }),
      ),
    ).toBe("eyes");
    expect(advanceMention(queued, { type: "session.inbox.delivered", data: { sessionID, inboxID } })).toEqual(
      delivered,
    );
    expect(
      getMentionReaction(
        advanceMention(delivered, { type: "session.execution.succeeded", data: { sessionID } }),
      ),
    ).toBe("white_check_mark");
  });

  it("waits on simultaneous permissions and questions until they are all answered", function () {
    const events: Parameters<typeof advanceMention>[1][] = [
      { type: "permission.asked", data: { sessionID, id: "per_one" } },
      { type: "form.created", data: { form: { sessionID, id: "frm_one" } } },
      { type: "permission.replied", data: { sessionID, requestID: "per_one" } },
      { type: "form.replied", data: { sessionID, id: "frm_one" } },
    ];
    const [permission] = events;
    expect(getMentionReaction(advanceMention(queued, permission))).toBe("eyes");
    let state: ReturnType<typeof advanceMention> = delivered;
    const reactions = events.map(function (event) {
      if (state === "done" || state === "failed") {
        throw new Error("Expected a pending mention");
      }
      state = advanceMention(state, event);
      return getMentionReaction(state);
    });
    expect(reactions).toEqual(["raised_hand", "raised_hand", "raised_hand", "eyes"]);
  });

  it("does not blame an undelivered follow-up for the previous run's failure", function () {
    const failure = { type: "session.execution.failed", data: { sessionID } } satisfies Parameters<
      typeof advanceMention
    >[1];
    expect(getMentionReaction(advanceMention(delivered, failure))).toBe("x");
    expect(getMentionReaction(advanceMention(queued, failure))).toBe("eyes");
    expect(
      getMentionReaction(
        advanceMention(queued, { type: "session.inbox.cancelled", data: { sessionID, inboxID } }),
      ),
    ).toBe("x");
  });

  it("keeps a finished run waiting until its open form is answered", function () {
    const waiting: MentionState = { ...delivered, requests: new Set(["frm_one"]) };
    const finished = advanceMention(waiting, { type: "session.execution.succeeded", data: { sessionID } });
    expect(getMentionReaction(finished)).toBe("raised_hand");
    if (finished === "done" || finished === "failed") {
      throw new Error("Expected a pending mention");
    }
    expect(
      getMentionReaction(
        advanceMention(finished, { type: "form.replied", data: { sessionID, id: "frm_one" } }),
      ),
    ).toBe("white_check_mark");
  });
});

it("uses one event subscription across plugin instances and hands it over on unload", function () {
  const signals: (AbortSignal | undefined)[] = [];
  async function* subscribe(options?: { signal?: AbortSignal }) {
    signals.push(options?.signal);
    yield* [];
  }
  const stopFirst = listenForSessionEvents(subscribe);
  const stopSecond = listenForSessionEvents(subscribe);
  expect(signals.map((signal) => signal?.aborted)).toEqual([false]);
  stopFirst();
  expect(signals.map((signal) => signal?.aborted)).toEqual([true, false]);
  stopSecond();
  expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
});
