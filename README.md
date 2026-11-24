# opencode-slack

[OpenCode](https://opencode.ai) plugins that connect your agents to Slack. macOS only for now, sorry!

| Package                                                          | What it does                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@jonlinkens/opencode-slack-feedback`](packages/slack-feedback) | A `give_feedback` tool: agents report friction to a Slack channel for you to triage |
| [`@jonlinkens/opencode-slack-agent`](packages/slack-agent)       | Mention @OpenCode in a Slack thread to start or continue a session locally          |

## Development

Run `bun install` and `bun run check`. For a change that should ship, run `bun changeset` and commit the generated file with your change. The three packages share one version.

## Release

Merging a changeset to `main` opens or updates the **Version Packages** PR. Merging that PR publishes the new versions to npm and creates GitHub releases.

The Release workflow publishes with npm trusted publishing, so it needs no token. Each package trusts `jonlinkens/opencode-slack`, workflow `release.yml`, environment `npm`. The `npm` environment only runs on `main`.

Run `bun run release --dry-run` to see which versions would be published without packing, publishing, or tagging.
