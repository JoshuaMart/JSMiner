![JSMiner](https://github.com/user-attachments/assets/bf6d4233-ba98-4cf7-9207-8d86676e6247)

<p align="center">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-red.svg" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/TypeScript-6.0.3-blue?logo=typescript" alt="TypeScript 6.0.3">
    <img src="https://img.shields.io/badge/Node.js-24.21.0-green?logo=nodedotjs" alt="Node.js 24.21.0">
</p>

# JSMiner

A private service for static JavaScript analysis: endpoints, potential secrets, GraphQL operations, and subdomains. Results stay compact; source modules are retrieved separately using a `handle`.

## Run with Docker

Requires Docker with Linux containers. The API runs at **http://127.0.0.1:3001**, with persistent data in `jsminer-data`.

<details>
<summary><strong>Pull, initialize and start</strong></summary>

Run these commands in the same terminal. Initialize the volume only once.

```sh
JSMINER_TAG=latest
JSMINER_IMAGE="ghcr.io/joshuamart/jsminer:$JSMINER_TAG"
docker pull "$JSMINER_IMAGE"
docker pull "ghcr.io/joshuamart/jsminer-jsluice:$JSMINER_TAG"
docker pull "ghcr.io/joshuamart/jsminer-offline:$JSMINER_TAG"

# First run only: create configuration and token.
docker run --rm \
  --mount type=volume,src=jsminer-data,dst=/data \
  -e JSMINER_IMAGE_TAG="$JSMINER_TAG" \
  "$JSMINER_IMAGE" node /app/init-config.mjs --docker
```

Start the API:

```sh
JSMINER_DOCKER_SOCKET=/var/run/docker.sock
JSMINER_DOCKER_GID=$(docker run --rm \
  --mount "type=bind,src=$JSMINER_DOCKER_SOCKET,dst=/var/run/docker.sock" \
  "$JSMINER_IMAGE" stat -c '%g' /var/run/docker.sock)

docker run -d --name jsminer --restart unless-stopped \
  --user "node:$JSMINER_DOCKER_GID" \
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

The API uses the Docker socket to start offline workers; access to this socket grants control of the Docker host. See [operations](docs/src/content/docs/guides/operations.md#déploiement-docker) for images, upgrades and volume recovery.

## Analyze JavaScript

After starting the container:

```sh
curl --fail-with-body http://127.0.0.1:3001/analyze \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"fetch(\"/api/profile\");","tools":["jsluice"]}'
```

Use `/jobs` for asynchronous batches of up to 50 scripts. [More examples →](docs/src/content/docs/guides/analysis.md)

## Documentation

Documentation is in French:

- [Install from source](docs/src/content/docs/guides/quickstart.md) · [Development and tests](docs/src/content/docs/guides/development.md)
- [API reference](docs/src/content/docs/reference/api.md) · [Results](docs/src/content/docs/reference/results.md) · [Configuration](docs/src/content/docs/reference/configuration.md)
- [Operations](docs/src/content/docs/guides/operations.md) · [Known limitations](docs/src/content/docs/guides/limitations.md)
