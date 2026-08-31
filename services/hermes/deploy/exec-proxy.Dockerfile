# The exec proxy, with one line of setup the stock image cannot do for us.
#
# `group_add` on the compose service is not enough, and the reason is easy to
# miss: it adds the group to the container's *initial* process, and nginx then
# drops its workers to the `nginx` user, which takes its supplementary groups
# from /etc/group inside the image. `id nginx` showed `groups=101(nginx)` while
# `id` for root showed 988 -- so the master could have read the socket and the
# workers, which do the proxying, could not. The symptom was a 502 and a
# `connect() ... failed (13: Permission denied)` in the proxy's log.
#
# The alternative was running the workers as root. It would have worked and it
# would not even have been much worse -- anything that can talk to this socket
# has the daemon regardless of its uid. But "the proxy runs as root" is a
# sentence somebody would have to re-derive the harmlessness of later, and one
# line here means nobody has to.
ARG DOCKER_GID=988
FROM nginx:1.27-alpine
ARG DOCKER_GID

# The socket's group on the host. `stat -c %g /var/run/docker.sock` -- it is
# host-specific, so it is a build argument rather than a constant. If the gid
# already exists in the image, join whatever it is called there instead of
# failing on a duplicate.
RUN set -eux; \
    if ! getent group "${DOCKER_GID}" >/dev/null; then \
        addgroup -g "${DOCKER_GID}" dockersock; \
    fi; \
    addgroup nginx "$(getent group "${DOCKER_GID}" | cut -d: -f1)"; \
    id nginx
