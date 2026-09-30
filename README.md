![JSMiner](https://github.com/user-attachments/assets/bf6d4233-ba98-4cf7-9207-8d86676e6247)

<p align="center">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-red.svg" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/TypeScript-6.0.3-blue?logo=typescript" alt="TypeScript 6.0.3">
    <img src="https://img.shields.io/badge/Node.js-24.21.0-green?logo=nodedotjs" alt="Node.js 24.21.0">
</p>

# JSMiner

A private service for static JavaScript analysis: endpoints, potential secrets, GraphQL operations, and subdomains. Results stay compact; source modules are retrieved separately using a `handle`.

[Docker](#run-with-docker) · [Documentation](#documentation) · [Development](#development)

## Run with Docker

Requires Docker with Linux containers. The API will be available at **http://127.0.0.1:3001**. Run steps 1 and 2 in the same terminal; initialization is only needed once.

<details>
<summary><strong>Images and release tags</strong></summary>

The validation workflow publishes these images to GHCR for `linux/amd64` and `linux/arm64` after its checks pass:

| Image | Role |
| --- | --- |
| `ghcr.io/joshuamart/jsminer` | HTTP API |
| `ghcr.io/joshuamart/jsminer-jsluice` | jsluice worker |
| `ghcr.io/joshuamart/jsminer-offline` | Transformations, TruffleHog, GraphQL and domain extraction |

Pushes to `main` publish `latest`; Git tags starting with `v` publish the same image tag. Every publication also includes `sha-<full-commit-sha>`. Images become available after the first successful publication. If the packages are private, run `docker login ghcr.io` first.

The API orchestrates two worker images: a standalone Go binary for jsluice, and a Node.js environment for webcrack, Wakaru, GraphQL and domain extraction, which also includes the TruffleHog binary. Both worker images run offline in temporary containers started by the API.

</details>

<details open>
<summary><strong>1. Pull the images and initialize storage</strong></summary>

Pull all three images with the same tag:

```sh
JSMINER_TAG=latest
JSMINER_IMAGE="ghcr.io/joshuamart/jsminer:$JSMINER_TAG"
docker pull "$JSMINER_IMAGE"
docker pull "ghcr.io/joshuamart/jsminer-jsluice:$JSMINER_TAG"
docker pull "ghcr.io/joshuamart/jsminer-offline:$JSMINER_TAG"
```

Initialize the persistent volume once. This creates a private token and configuration; it refuses to overwrite existing data.

```sh
docker run --rm \
  --mount type=volume,src=jsminer-data,dst=/data \
  -e JSMINER_IMAGE_TAG="$JSMINER_TAG" \
  "$JSMINER_IMAGE" node /app/init-config.mjs --docker
```

</details>

<details>
<summary><strong>2. Start the API and check authentication</strong></summary>

The API uses the Docker socket to create isolated worker containers. Socket access grants control of the Docker host; workers receive neither this socket nor network access. The following commands keep the API running as a non-root user with the socket's group:

```sh
JSMINER_DOCKER_SOCKET=/var/run/docker.sock
JSMINER_DOCKER_GID=$(docker run --rm \
  --mount "type=bind,src=$JSMINER_DOCKER_SOCKET,dst=/var/run/docker.sock" \
  "$JSMINER_IMAGE" stat -c '%g' /var/run/docker.sock)

docker run -d --name jsminer --restart unless-stopped \
  --group-add "$JSMINER_DOCKER_GID" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=volume,src=jsminer-data,dst=/data \
  --mount "type=bind,src=$JSMINER_DOCKER_SOCKET,dst=/var/run/docker.sock" \
  -p 127.0.0.1:3001:3000 \
  "$JSMINER_IMAGE"

JSMINER_TOKEN=$(docker exec jsminer cat /data/.local/token)
curl --fail-with-body -H "Authorization: Bearer $JSMINER_TOKEN" \
  http://127.0.0.1:3001/health
```

</details>

<details>
<summary><strong>Storage, restart and upgrades</strong></summary>

The host API port is **3001**; the container listens on **3000**. Configuration, credentials, SQLite, sources and cache are stored in `jsminer-data` under `.local/`. Stop with `docker stop jsminer` and resume with `docker start jsminer`. To change image tags later, update `worker_image` and `offline_worker_image` in `/data/.local/config.json`, pull the matching images and recreate the API container using the same volume.

</details>

## Documentation

The documentation is currently in French:

- [Installation](docs/src/content/docs/guides/quickstart.md)
- [Request examples](docs/src/content/docs/guides/analysis.md)
- [Configuration](docs/src/content/docs/reference/configuration.md)
- [HTTP API](docs/src/content/docs/reference/api.md) and [result model](docs/src/content/docs/reference/results.md)
- [Operations](docs/src/content/docs/guides/operations.md) and [development](docs/src/content/docs/guides/development.md)
- [Known limitations and plans beyond v0.1](docs/src/content/docs/guides/limitations.md)

The documentation site has its own workspace: run `pnpm --dir docs install --frozen-lockfile`, then `pnpm --dir docs dev`.

## Development

<details>
<summary><strong>Build and run from source</strong></summary>

With pnpm **10.33.0** and Docker available, run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm worker:build
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

The workspace selects Node.js **24.21.0**. The API listens on `127.0.0.1:3000` by default. Configuration and the access token are stored in `.local/`; initialization refuses to overwrite an existing directory.

</details>

<details>
<summary><strong>Validation and integration tests</strong></summary>

`pnpm check` runs linting, contract checks, builds, type checks, and local tests. `pnpm test:workers` adds Docker integration tests. The [qualification harness](qualification/README.md) measures quality and resource usage against a synthetic corpus.

To validate the API image locally after building the workers, run `docker build --target runtime -t jsminer-api:test .`, then `pnpm test:image`. The image test checks authentication, both worker images, and source/cache persistence across container replacement, then removes its temporary containers and volume.

</details>
