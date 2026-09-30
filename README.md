![JSMiner](https://github.com/user-attachments/assets/bf6d4233-ba98-4cf7-9207-8d86676e6247)

<p align="center">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-red.svg" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/TypeScript-6.0.3-blue?logo=typescript" alt="TypeScript 6.0.3">
    <img src="https://img.shields.io/badge/Node.js-24.21.0-green?logo=nodedotjs" alt="Node.js 24.21.0">
</p>

# JSMiner

A private service for static JavaScript analysis: endpoints, potential secrets, GraphQL operations, and subdomains. Results stay compact; source modules are retrieved separately using a `handle`.

## Quick start

With pnpm **10.33.0** and Docker available, run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm worker:build
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

The workspace selects Node.js **24.21.0**. The API listens on `127.0.0.1:3000` by default. Configuration and the access token are stored in `.local/`; initialization refuses to overwrite an existing directory.

## Documentation

The documentation is currently in French:

- [Installation](docs/src/content/docs/guides/quickstart.md)
- [Request examples](docs/src/content/docs/guides/analysis.md)
- [Configuration](docs/src/content/docs/reference/configuration.md)
- [HTTP API](docs/src/content/docs/reference/api.md) and [result model](docs/src/content/docs/reference/results.md)
- [Operations](docs/src/content/docs/guides/operations.md) and [development](docs/src/content/docs/guides/development.md)
- [Known limitations and plans beyond v0.1](docs/src/content/docs/guides/limitations.md)

The documentation site has its own workspace: run `pnpm --dir docs install --frozen-lockfile`, then `pnpm --dir docs dev`.

## Validation

`pnpm check` runs linting, contract checks, builds, type checks, and local tests. `pnpm test:workers` adds Docker integration tests. The [qualification harness](qualification/README.md) measures quality and resource usage against a synthetic corpus.
