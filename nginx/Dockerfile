FROM nginx:alpine
RUN apk add --no-cache openssl
COPY 05-ssl-bootstrap.sh /docker-entrypoint.d/05-ssl-bootstrap.sh
RUN chmod +x /docker-entrypoint.d/05-ssl-bootstrap.sh
