# opencode-slack

[OpenCode](https://opencode.ai) plugins that connect your agents to Slack. macOS only for now, sorry!

| Package                                                          | What it does                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@jonlinkens/opencode-slack-feedback`](packages/slack-feedback) | A `give_feedback` tool: agents report friction to a Slack channel for you to triage |
| [`@jonlinkens/opencode-slack-agent`](packages/slack-agent)       | Mention @OpenCode in a Slack thread to start or continue a session locally          |

## Development

Run `bun install` and `bun run check`. For a change that should ship, run `bun changeset` and commit the generated file with your change. The three packages share one version.

## Release

Merging a changeset to `main` opens or updates the **Version Packages** PR. Merging that PR publishes the new versions to npm and creates GitHub releases. A push to `main` with no pending changesets publishes any current versions that are not on npm, including the initial `0.1.0`.

1. In the public GitHub repo, go to **Settings → Actions → General → Workflow permissions** and enable **Allow GitHub Actions to create and approve pull requests**.
2. In **Settings → Environments**, create `npm`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main` as a branch rule.
3. Before pushing the Release workflow to `main`, create an npm granular access token with write access to the `@jonlinkens` scope and **Bypass 2FA**. Add it as the `NPM_TOKEN` secret in the `npm` environment. Trusted publishing is not yet available for these packages. Alternatively, run `bun pm pack` in each package and `npm publish <tarball> --access public`, shared first, then create the initial GitHub releases yourself.
4. After all three packages exist on npm, open each package’s **Settings → Trusted Publisher** and choose **GitHub Actions**. Set the owner to `jonlinkens`, repository to `opencode-slack`, workflow filename to `release.yml`, and environment to `npm`. Allow direct `npm publish`. Delete the `NPM_TOKEN` environment secret and revoke the token once all three trusted publishers are configured.

Run `bun run release --dry-run` to see which versions would be published without packing, publishing, or tagging.
