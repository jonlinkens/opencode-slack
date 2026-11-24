# @jonlinkens/opencode-slack-feedback

An [OpenCode](https://opencode.ai) plugin that gives agents a `give_feedback` tool. When an agent hits friction or a bug unrelated to its current task, it reports the problem to a Slack channel without stopping its work.

Agents only report problems about code that you own: the repository they work in, your instructions, and your personal agent config. They skip problems third-party packages, external tools and services.

Each report is written so another agent can pick it up later with no other context: what happened.

## Setup

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, and pick your workspace.
2. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and create the app.
3. **Install App** → **Install to workspace**.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**.

### 2. Store the token in the Keychain

```sh
security add-generic-password -a "$USER" -s opencode-slack-feedback -w # add -U to replace an existing token
```

### 3. Invite the bot

In the channel that receives reports, run `/invite @OpenCode`. Then copy the channel ID: open the channel details, and the ID (`C…`) is at the bottom.

### 4. Add the plugin

In `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "@jonlinkens/opencode-slack-feedback",
      "options": { "channel": "C0123ABCD" },
    },
  ],
}
```

### Config

| Option            | Required | Default                   | Description                         |
| ----------------- | -------- | ------------------------- | ----------------------------------- |
| `channel`         | Yes      |                           | ID of the channel to post to.       |
| `keychainService` | No       | `opencode-slack-feedback` | Keychain item that holds the token. |

## Triage

Triage reports by hand by reacting to the channel post:

| Reaction                | Meaning         |
| ----------------------- | --------------- |
| ✅ `:white_check_mark:` | Fixed           |
| 💡 `:bulb:`             | Feature request |
| 🚫 `:no_entry_sign:`    | Not a bug       |

Agents with the Slack MCP can then filter on them, for example:

- _"List the reports in #my-feedback that are still unresolved."_
