#!/bin/sh
set -eu

# RPM passes 1 for an upgrade; Debian may pass upgrade-related action names.
# In those cases the newly installed package still owns the helper and policy.
case "${1:-}" in
  1|upgrade|failed-upgrade|abort-install|abort-upgrade|disappear) exit 0 ;;
esac

rm -f /usr/lib/library-tagger/library-tagger-core
rm -f /usr/share/polkit-1/actions/io.github.navid079.library-tagger.policy
rmdir /usr/lib/library-tagger 2>/dev/null || true
