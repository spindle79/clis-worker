#!/bin/sh
set -e

mkdir -p /root/.ScreamingFrogSEOSpider

if [ -n "$SCREAMING_FROG_LICENCE_USER" ] && [ -n "$SCREAMING_FROG_LICENCE_KEY" ]; then
  printf '%s\n%s\n' "$SCREAMING_FROG_LICENCE_USER" "$SCREAMING_FROG_LICENCE_KEY" \
    > /root/.ScreamingFrogSEOSpider/licence.txt
fi

if [ "$SCREAMING_FROG_EULA" = "accepted" ]; then
  if ! grep -q '^eula\.accepted=15$' /root/.ScreamingFrogSEOSpider/spider.config 2>/dev/null; then
    printf 'eula.accepted=15\nstorage.mode=DB\n' >> /root/.ScreamingFrogSEOSpider/spider.config
  fi
fi

exec /usr/bin/tini -- "$@"
