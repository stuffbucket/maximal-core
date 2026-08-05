#!/usr/bin/env bash
# Pre-commit secret scan. Called from lint-staged with the list of
# staged file paths as positional args.
#
# Behavior:
#  - If trufflehog is missing, warn once and exit 0 (don't block work
#    for contributors who haven't installed it yet).
#  - Otherwise run filesystem scan with --no-verification (regex/entropy
#    only, no network). Fail-closed: any finding blocks the commit.
#  - Override with SKIP_SECRET_SCAN=1 for the rare commit where you
#    know the hit is a fixture (better: add a path-based allowlist
#    rather than skipping the whole hook).
#
# CI runs the verified variant via .github/workflows/secret-scan.yml.

set -euo pipefail

if [ "${SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "[secret-scan] SKIP_SECRET_SCAN=1 — bypassed"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! command -v trufflehog >/dev/null 2>&1; then
  cat >&2 <<EOF
[secret-scan] trufflehog not installed — skipping pre-commit scan.
              Install with: brew install trufflehog
              CI will still scan this PR.
EOF
  exit 0
fi

# Filter to regular existing files; lint-staged may pass deleted paths
# during rename-style commits, and trufflehog filesystem dislikes them.
paths=()
for p in "$@"; do
  [ -f "$p" ] && paths+=("$p")
done

if [ "${#paths[@]}" -eq 0 ]; then
  exit 0
fi

# --no-verification: regex/entropy only, no network round-trip.
# --results: pinned rather than defaulted. trufflehog 3.96.0's own
#            `--help` states the default is already
#            `verified,unverified,unknown`, so this is currently a
#            no-op — it is here so a future default change cannot
#            silently narrow what we act on.
# --fail: exit non-zero when anything is reported. MEASURED on
#         trufflehog 3.96.0 against a planted high-entropy fake `ghp_`
#         token, which the Github detector reports as UNVERIFIED:
#
#           --no-verification --fail                        -> 183
#           --no-verification --fail --results=<all three>  -> 183
#           --fail (verification on)                        -> 183
#           --no-verification, no --fail                    -> 0
#           --no-verification --fail, clean tree            -> 0
#
#         So `--fail` fires on unverified findings and combines fine
#         with `--no-verification`. An earlier comment here claimed the
#         opposite (that `--fail` only trips on *verified* findings, and
#         that the default `--results` reports only verified ones);
#         both claims were wrong for this version, and the second is
#         contradicted by trufflehog's own `--help` text.
# --no-update: don't phone home to check for a new trufflehog release.
#
# The `Found …result` grep below is kept as a fallback for older
# trufflehog builds where `--fail` may not have behaved this way; on
# 3.96.0 the exit code alone is sufficient. Note the `|| status=$?`:
# under `set -e` a bare `output=$(trufflehog … --fail)` would abort the
# script on exit 183 before anything was printed.
status=0
output=$(trufflehog filesystem "${paths[@]}" \
  --no-verification \
  --results=verified,unknown,unverified \
  --fail \
  --no-update 2>&1) || status=$?
echo "$output"

# 183 == "--fail was set and results were found". Any other non-zero
# status is trufflehog itself failing, and is propagated as-is.
if [ "$status" -eq 183 ] \
  || printf '%s\n' "$output" | grep -qE '^Found (verified|unverified|unknown) result'; then
  echo "[secret-scan] ✖ blocked: secrets detected in staged changes" >&2
  echo "[secret-scan]   if this is a false positive, add the path to" >&2
  echo "[secret-scan]   .trufflehog-exclude or set SKIP_SECRET_SCAN=1" >&2
  exit 1
fi
if [ "$status" -ne 0 ]; then
  exit "$status"
fi
exit 0
