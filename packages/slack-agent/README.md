# @jonlinkens/opencode-slack-agent

Mentioning **@OpenCode** in any Slack channel the bot is in:

- starts a local OpenCode session with the thread as context
- opens it in [Rex](https://superlogical.com/rex)
- sends later mentions in that thread to the same session.

This plugin pairs nicely with [`@jonlinkens/opencode-slack-feedback`](../slack-feedback): reply `@OpenCode fix this` on a report to start a session in the report's repo and branch.

The bot reacts to your mention to show progress:

| Reaction | Meaning                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| 👀       | OpenCode accepted the mention. It is queued or running.                                                            |
| ✅       | OpenCode finished the work for this mention.                                                                       |
| ✋       | Your turn: usually a permission prompt or question in OpenCode or Rex, or the bot needs to know which repo to use. |
| ❌       | OpenCode failed or stopped, or the bot couldn't handle the mention.                                                |

## Setup

### 1. Configure the Slack app

Use the same app as `@jonlinkens/opencode-slack-feedback`. Merge [`slack-app-manifest.yaml`](slack-app-manifest.yaml) into its manifest, or change these settings by hand:

1. **Socket Mode:** needs to be turned on. Create an app-level token with the `connections:write` scope and copy it (`xapp-…`).
2. **Event Subscriptions:** also needs turning on. Under **Subscribe to bot events** add `app_mention`.
3. **OAuth & Permissions → Bot Token Scopes:** add `app_mentions:read`, `channels:history`, `groups:history`, and `reactions:write`.
4. Reinstall the app in Slack after making the changes above.

### 2. Store the tokens in the macOS Keychain

```sh
# skip this one if you've already set up @jonlinkens/opencode-slack-feedback
security add-generic-password -a "$USER" -s opencode-slack-feedback -w
security add-generic-password -a "$USER" -s opencode-slack-agent-app -w
```

### 3. Add the plugin

```jsonc
{
  "plugins": [
    {
      "package": "@jonlinkens/opencode-slack-agent",
      "options": { "allowedUsers": ["YOUR_SLACK_ID"] },
    },
  ],
}
```

## Config

| Option               | Default                     | Description                                                                                    |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `allowedUsers`       | required                    | Slack user IDs that can start sessions. Everyone else is ignored.                              |
| `channels`           | every channel the bot is in | Only answer mentions in these channel IDs.                                                     |
| `roots`              | `["~/dev"]`                 | Folders whose direct subfolders are searched for a checkout.                                   |
| `repos`              | `{}`                        | Explicit map, such as `{ "acme/app": "~/code/app" }`. Checked before roots.                    |
| `worktrees`          | `"auto"`                    | Isolate new sessions if needed (`"auto"`), every time (`"always"`), or not at all (`"never"`). |
| `rex`                | `true`                      | Open the session in Rex.                                                                       |
| `rexFocus`           | `false`                     | Switch the Rex app to the new session.                                                         |
| `botKeychainService` | `opencode-slack-feedback`   | Keychain item with the bot token.                                                              |
| `appKeychainService` | `opencode-slack-agent-app`  | Keychain item with the app-level token.                                                        |

## Choosing the repo to work in

You can:

- name the repo in your mention: `@OpenCode in app fix the login bug`
- link a GitHub repository

If you don't name one, the bot checks your earlier mentions in the thread, then the feedback report from `@jonlinkens/opencode-slack-feedback` if there is one.

The `repos` map in config takes priority over Git checkouts found one folder below `roots`. For feedback reports, the bot can also use the report's directory. If no checkout matches, the bot replies with a list of the local repos it knows.

## Follow-ups

Mention `@OpenCode` again in the same thread to send a follow-up. It goes to the existing session and doesn't open another Rex session. If the agent is busy, OpenCode queues the message instead of interrupting the current turn.

The Slack channel and thread timestamps are stored on the OpenCode session, so follow-ups still work after a restart. If the session is deleted, the next mention starts a new one using the same repo rules.
