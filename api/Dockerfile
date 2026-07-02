FROM php:8.2-apache

RUN docker-php-ext-install mysqli pdo pdo_mysql

COPY . /var/www/html/

# Railway's base image sometimes ends up with more than one Apache MPM
# (multi-processing module) enabled at once, which crashes Apache on
# startup with "AH00534: More than one MPM loaded." PHP's Apache module
# only works with mpm_prefork, so we force-disable the others and
# re-enable only prefork right before starting the server.
#
# Apache listens on its default port 80 here — Railway's Target Port
# for this service is fixed at 80, so we do NOT rewrite the port and
# instead just let Apache use its out-of-the-box default.
CMD ["bash", "-lc", "\
    set -e; \
    a2dismod mpm_event mpm_worker >/dev/null 2>&1 || true; \
    rm -f /etc/apache2/mods-enabled/mpm_event.* /etc/apache2/mods-enabled/mpm_worker.* || true; \
    a2enmod mpm_prefork >/dev/null 2>&1 || true; \
    apache2ctl -t; \
    exec apache2-foreground \
"]
