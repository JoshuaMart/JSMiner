FROM node:24.21.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates && rm -r /var/lib/apt/lists/*
WORKDIR /worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) sum=40377e6572495412fb9ba0bc21c9401f73b72f1d2afd11b9931bc4a5ed622866 ;; arm64) sum=372c568695d49e53517075b5f74d1ee9a19053f13661d689c7928ee1fc27d705 ;; *) exit 1 ;; esac && curl -fsSL "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.9/trufflehog_3.97.9_linux_${TARGETARCH}.tar.gz" -o /tmp/truffle.tar.gz && echo "$sum  /tmp/truffle.tar.gz" | sha256sum -c - && tar -xzf /tmp/truffle.tar.gz -C /usr/local/bin trufflehog && rm /tmp/truffle.tar.gz
FROM node:24.21.0-bookworm-slim
LABEL io.jsminer.protocol="1" io.jsminer.adapter="offline" io.jsminer.version="webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static2"
COPY --from=build /worker /worker
COPY --from=build /usr/local/bin/trufflehog /usr/local/bin/trufflehog
COPY *.mjs LICENSE-trufflehog /worker/
WORKDIR /worker
ENV HOME=/tmp DISABLE_TELEMETRY=true
USER 65532:65532
ENTRYPOINT ["node", "--no-node-snapshot", "worker.mjs"]
