FROM haproxy:alpine

ENV PORT=8000
ENV DOMAIN=localhost
ENV HYDRA_PUBLIC_SERVICE=localhost
ENV HYDRA_ADMIN_SERVICE=localhost
ENV LOGIN_SERVICE=localhost
ENV WRAPPER_SERVICE=localhost
ENV INTROSPECT_ACCESS_USER=user
ENV INTROSPECT_ACCESS_PASS=pass

COPY haproxy.conf /usr/local/etc/haproxy/haproxy.cfg

RUN haproxy -f /usr/local/etc/haproxy/haproxy.cfg -c