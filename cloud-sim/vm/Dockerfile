# «VM» de un asistente (decisión D6): Docker-in-Docker con lo que trae una VM
# COS para el watcher (bash, curl y utilidades GNU). Sin systemd ni iptables
# propios: el entrypoint hace lo que en GCE hacen el startup-script y systemd.
FROM docker:27.5.1-dind
RUN apk add --no-cache bash curl coreutils tar gzip findutils sed grep gawk dnsmasq ca-certificates
COPY entrypoint.sh /usr/local/bin/vm-entrypoint.sh
RUN chmod 0755 /usr/local/bin/vm-entrypoint.sh
ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["/usr/local/bin/vm-entrypoint.sh"]
