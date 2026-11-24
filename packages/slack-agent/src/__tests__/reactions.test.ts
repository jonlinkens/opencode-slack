import { describe, expect, it, vi } from "vitest";
import { slackSuccessSchema } from "@jonlinkens/opencode-slack-shared";

import { createMentionReaction, planReactionChange, writeReaction } from "../reactions.ts";

const message = { channel: "C123", ts: "1.2" };

describe("mention reactions", function () {
  it("replaces the previous reaction and skips unchanged reactions", function () {
    expect(planReactionChange(undefined, "eyes")).toEqual([{ method: "reactions.add", name: "eyes" }]);
    expect(planReactionChange("eyes", "eyes")).toEqual([]);
    expect(planReactionChange("eyes", "white_check_mark")).toEqual([
      { method: "reactions.remove", name: "eyes" },
      { method: "reactions.add", name: "white_check_mark" },
    ]);
  });

  it("serializes changes even if the session finishes before Slack acknowledges acceptance", async function () {
    const write = vi.fn(async function () {});
    const update = createMentionReaction(write);
    update("eyes");
    update("raised_hand");
    update("raised_hand");
    await update("white_check_mark");
    expect(write.mock.calls.flat()).toEqual([
      { method: "reactions.add", name: "eyes" },
      { method: "reactions.remove", name: "eyes" },
      { method: "reactions.add", name: "raised_hand" },
      { method: "reactions.remove", name: "raised_hand" },
      { method: "reactions.add", name: "white_check_mark" },
    ]);
  });

  it("sends the mention address and tolerates only idempotent Slack errors", async function () {
    const call = vi.fn<NonNullable<Parameters<typeof writeReaction>[3]>>();
    call.mockRejectedValueOnce(new Error("Slack reactions.add failed: already_reacted"));
    call.mockRejectedValueOnce(new Error("Slack reactions.remove failed: no_reaction"));
    call.mockRejectedValueOnce(new Error("Slack reactions.add failed: missing_scope"));
    await writeReaction("token", message, { method: "reactions.add", name: "eyes" }, call);
    await writeReaction("token", message, { method: "reactions.remove", name: "eyes" }, call);
    expect(call).toHaveBeenNthCalledWith(
      1,
      "reactions.add",
      "token",
      { channel: "C123", timestamp: "1.2", name: "eyes" },
      slackSuccessSchema,
    );
    await expect(
      writeReaction("token", message, { method: "reactions.add", name: "eyes" }, call),
    ).rejects.toThrow("missing_scope");
  });
});
