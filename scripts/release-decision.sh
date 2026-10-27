#!/usr/bin/env bash
# Decide what a run of .github/workflows/release.yml does. Reads package.json and
# the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_REF_TYPE,
# GITHUB_REF_NAME, GITHUB_SHA) and writes name, version, tag, dist_tag and
# publish to GITHUB_OUTPUT. Only a push publishes: a pushed v<version> tag on
# main, or a push to main whose version has no tag yet. A manual run, on a branch
# or a tag, checks without publishing. test/release-decision.test.ts covers each
# case.
set -euo pipefail

name="$(node -p 'require("./package.json").name')"
version="$(node -p 'require("./package.json").version')"
tag="v${version}"
echo "name=${name}" >> "$GITHUB_OUTPUT"
echo "version=${version}" >> "$GITHUB_OUTPUT"
echo "tag=${tag}" >> "$GITHUB_OUTPUT"

publish=false
if [ "$GITHUB_REF_TYPE" = "tag" ]; then
  if [ "$GITHUB_REF_NAME" != "$tag" ]; then
    echo "::error title=Tag does not match package.json::Tag ${GITHUB_REF_NAME} does not match package.json version ${version}. Tag the release as ${tag}."
    exit 1
  fi
  if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then
    echo "::error title=Tag is not on main::${GITHUB_REF_NAME} points at ${GITHUB_SHA}, which is not on main."
    exit 1
  fi
  # A manual run on a tag checks it and publishes nothing.
  if [ "$GITHUB_EVENT_NAME" = "push" ]; then
    publish=true
  fi
elif [ "$GITHUB_EVENT_NAME" = "push" ]; then
  # A push to main releases its version once: the release tags it.
  if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    echo "${tag} is already tagged; nothing to release."
    echo "publish=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  publish=true
fi
echo "publish=${publish}" >> "$GITHUB_OUTPUT"

# Same dist-tag policy as @withautonomi/ant: the first dot-separated pre-release
# identifier decides, and an unrecognised one fails rather than moving `latest`.
pre=""
if [ "$version" != "${version%%-*}" ]; then
  pre="${version#*-}"
fi
if [ -z "$pre" ]; then
  dist_tag="latest"
else
  case "${pre%%.*}" in
    beta) dist_tag="beta" ;;
    rc) dist_tag="rc" ;;
    *)
      echo "::error title=Unrecognised pre-release::Version ${version} has pre-release identifier '${pre%%.*}', which maps to no npm dist-tag."
      exit 1
      ;;
  esac
fi

echo "dist_tag=${dist_tag}" >> "$GITHUB_OUTPUT"
if [ "$publish" = true ]; then
  echo "Releasing ${name}@${version} to dist-tag ${dist_tag}"
else
  echo "Checking ${name}@${version} without publishing"
fi
