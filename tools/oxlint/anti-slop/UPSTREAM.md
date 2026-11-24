# Anti-slop provenance

- Source repository: <https://github.com/dmmulroy/anti-slop>
- Source commit: `95a56e5d24fb3d849673c2d51eb0908b8bd2d33b`
- Source path: `skills/install-anti-slop/assets/anti-slop/`
- Verified Git tree: `9e8e6b895c74ebee206ef03e11fa301fc23865e4`
- Installed paths: `tools/oxlint/anti-slop/index.ts`, `rules/`, `shared/`, and `effect/`.

The skill installer copied the source tree without changes. This provenance file is
the only local addition to that tree. The root Oxlint config registers the generic
plugin only; the Effect plugin is vendored but not enabled because this repository
does not depend on `effect`.
