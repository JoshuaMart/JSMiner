FROM golang:1.26.1-bookworm AS build
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags='-s -w -linkmode external -extldflags "-static"' -o /worker .

FROM scratch
LABEL io.jsminer.protocol="3" io.jsminer.adapter="jsluice" io.jsminer.version="0ddfab153e060a9eeaded4d8669233f7c071e7e4"
COPY --from=build /worker /worker
COPY UPSTREAM-LICENSE /LICENSE-jsluice
USER 65532:65532
ENTRYPOINT ["/worker"]
