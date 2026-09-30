FROM golang:1.26.1-bookworm AS build
WORKDIR /build
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /fixture main.go
FROM scratch
LABEL io.jsminer.protocol="3" io.jsminer.version="0ddfab153e060a9eeaded4d8669233f7c071e7e4"
COPY --from=build /fixture /fixture
USER 65532:65532
ENTRYPOINT ["/fixture"]
