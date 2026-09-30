FROM golang:1.26.1-bookworm AS build
WORKDIR /build
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /fixture main.go
FROM scratch
ARG JSLUICE_VERSION
LABEL io.jsminer.protocol="3" io.jsminer.version="${JSLUICE_VERSION}"
COPY --from=build /fixture /fixture
USER 65532:65532
ENTRYPOINT ["/fixture"]
