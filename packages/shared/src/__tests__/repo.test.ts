import { describe, expect, it } from "vitest";

import { parseGitRemote } from "../repo.ts";

describe("parseGitRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app", "https://github.com/acme/app"],
    ["git@github.com:acme/app", "acme/app", "https://github.com/acme/app"],
    ["https://github.com/acme/app.git", "acme/app", "https://github.com/acme/app"],
    ["https://user:token@github.com/acme/app", "acme/app", "https://github.com/acme/app"],
    ["ssh://git@gitlab.com:2222/group/sub/app.git", "group/sub/app", "https://gitlab.com/group/sub/app"],
    ["https://github.com/acme/app.git\n", "acme/app", "https://github.com/acme/app"],
  ])("%s", (remote, name, url) => {
    expect(parseGitRemote(remote)).toEqual({ name, url });
  });

  it("returns undefined for a remote it cannot parse", () => {
    expect(parseGitRemote("not a remote")).toBeUndefined();
  });
});
