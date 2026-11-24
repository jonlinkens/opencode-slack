import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { callSlackApi } from "../slack.ts";

const responseSchema = z.object({ ts: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps Slack's error when a failed response omits success fields", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ ok: false, error: "channel_not_found" })));

  await expect(callSlackApi("chat.postMessage", "token", {}, responseSchema)).rejects.toThrow(
    "Slack chat.postMessage failed: channel_not_found",
  );
});

it("rejects malformed success data", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ ok: true, ts: 123 })));

  await expect(callSlackApi("chat.postMessage", "token", {}, responseSchema)).rejects.toThrow(z.ZodError);
});

it("parses successful replies and form-encodes the request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(Response.json({ ok: true, ts: "1.2", extra: "ignored" })),
  );
  vi.stubGlobal("fetch", fetch);

  await expect(
    callSlackApi(
      "chat.postMessage",
      "token",
      { text: "hi", blocks: [{ type: "section" }], unfurl_links: false, omitted: undefined },
      responseSchema,
    ),
  ).resolves.toEqual({ ts: "1.2" });
  expect(fetch).toHaveBeenCalledWith(
    "https://slack.com/api/chat.postMessage",
    expect.objectContaining({
      body: new URLSearchParams({ text: "hi", blocks: '[{"type":"section"}]', unfurl_links: "false" }),
    }),
  );
});
