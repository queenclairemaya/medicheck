FROM php:8.2-apache

RUN docker-php-ext-install mysqli pdo pdo_mysql

COPY . /var/www/html/

# Apache's default port is 80. Railway injects $PORT at runtime and
# expects the container to listen on it, so we rewrite the Apache
# config right before starting the server (not at build time).
CMD sh -c "sed -i \"s/80/\${PORT:-80}/g\" /etc/apache2/ports.conf /etc/apache2/sites-enabled/000-default.conf && apache2-foreground"
