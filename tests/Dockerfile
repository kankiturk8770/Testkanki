# syntax=docker/dockerfile:1
FROM ubuntu:22.04
RUN --mount=type=secret,id=proxy_ca,target=/run/proxy-ca.pem \
    if [ -f /run/proxy-ca.pem ]; then export APT_CA='Acquire::https::CaInfo=/run/proxy-ca.pem'; else export APT_CA='Acquire::https::Verify-Peer=true'; fi; \
    apt-get -o "$APT_CA" update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o "$APT_CA" install -y --no-install-recommends \
      build-essential libssl-dev python3 iproute2 iptables ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src/KANKI
COPY . .
RUN make -C server -B && bash tests/run.sh
CMD ["bash", "tests/linux_netns.sh"]
