#!/bin/sh
# Runs the pinned Prettier with the given arguments. The pre-commit hook, CI
# and the docs call this script, so the version is only here.
exec npx --yes prettier@3.6.2 "$@"
