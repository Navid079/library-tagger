#!/bin/sh
set -eu
APP_ROOT="/opt/Library Tagger/resources"
install -D -m 0755 "$APP_ROOT/bin/library-tagger-core" /usr/lib/library-tagger/library-tagger-core
install -D -m 0644 "$APP_ROOT/policy/io.github.navid079.library-tagger.policy" /usr/share/polkit-1/actions/io.github.navid079.library-tagger.policy
