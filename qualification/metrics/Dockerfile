ARG BASE_IMAGE=scratch
FROM golang:1.26.1-bookworm AS build
WORKDIR /build
COPY main.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /metrics main.go
FROM ${BASE_IMAGE}
COPY --from=build /metrics /metrics
# Entrypoint is supplied for each qualification image; production images are untouched.
