import { describe, expect, it } from "vitest";

import { findThreadSession, runInThreadOrder, sendThreadFollowUp } from "../sessions.ts";

const thread = { slackChannel: "C123", slackThreadTs: "1.2" };

describe("findThreadSession", function () {
  it("finds persisted metadata on later pages and requires both channel and thread timestamp", async function () {
    async function listSessions(input: { parentID?: null; cursor?: string }) {
      if (input.cursor) {
        expect(input).toEqual({ cursor: "next" });
        return { data: [{ id: "ses_thread", metadata: thread }], cursor: {} };
      }
      expect(input).toEqual({ parentID: null });
      return {
        data: [
          { id: "ses_bad_metadata", metadata: { slackChannel: 123 } },
          { id: "ses_another_channel", metadata: { ...thread, slackChannel: "C456" } },
          { id: "ses_another_thread", metadata: { ...thread, slackThreadTs: "1.3" } },
          { id: "ses_no_metadata" },
        ],
        cursor: { next: "next" },
      };
    }
    expect(await findThreadSession(thread, listSessions)).toBe("ses_thread");
  });

  it("returns no mapping when the session is gone", async function () {
    const session = await findThreadSession(thread, async function () {
      return { data: [], cursor: { next: null } };
    });
    expect(session).toBeUndefined();
  });
});

describe("sendThreadFollowUp", function () {
  it("asks OpenCode to queue work for the existing session", async function () {
    const sent = await sendThreadFollowUp("ses_thread", "follow-up", async function (input) {
      expect(input).toEqual({ sessionID: "ses_thread", text: "follow-up", delivery: "queue" });
    });
    expect(sent).toBe(true);
  });

  it("allows a replacement if the session was removed after lookup", async function () {
    const sent = await sendThreadFollowUp("ses_thread", "follow-up", async function () {
      throw Object.assign(new Error("Missing session"), {
        _tag: "SessionNotFoundError",
        sessionID: "ses_thread",
      });
    });
    expect(sent).toBe(false);
  });

  it("surfaces other failures rather than starting a duplicate session", async function () {
    const sent = sendThreadFollowUp("ses_thread", "follow-up", async function () {
      throw new Error("Could not reach OpenCode");
    });
    await expect(sent).rejects.toThrow("Could not reach OpenCode");
  });
});

describe("runInThreadOrder", function () {
  it("runs another thread immediately without overlapping mentions in the same thread", async function () {
    const calls: string[] = [];
    const first = runInThreadOrder(thread, async function () {
      await Promise.resolve();
      calls.push("first");
    });
    const second = runInThreadOrder(thread, async function () {
      calls.push("second");
    });
    await runInThreadOrder({ ...thread, slackChannel: "C456" }, async function () {
      calls.push("other channel");
    });
    await Promise.all([first, second]);
    expect(calls).toEqual(["other channel", "first", "second"]);
  });
});
