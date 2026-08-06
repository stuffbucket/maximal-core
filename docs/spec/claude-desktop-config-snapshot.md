# Config snapshot for `configure-claude-desktop`

Status: **proposed, not implemented.**

Lifted verbatim from the Phase 5 distribution-simplification PRD when that
document was deleted. Phase 5 was about collapsing Windows install paths onto
an MSI; maximal ships no OS installer today, so the rest of it is moot. This
section is not — it is about *user-data reversibility*, which still matters:
`uninstall --force` should restore what it displaced, and today it can only
strip the keys it wrote.

Reference for what the two configuration tiers actually are:
[`docs/admin/claude-desktop-mdm.md`](../admin/claude-desktop-mdm.md).

## Design

New file: `${COPILOT_API_HOME}/state/claude-desktop.snapshot.json`.
Schema:

```jsonc
{
  "schemaVersion": 1,
  "capturedAt": "2026-05-08T00:00:00Z",
  "fileTier": {
    "path": "/Users/brian/Library/Application Support/Claude/claude_desktop_config.json",
    "priorKeys": {
      "inferenceProvider": "__UNSET__",
      "coworkEgressAllowedHosts": ["github.com", "*.github.com"],
      "...": "..."
    }
  },
  "mdmTier": {
    "domain": "com.anthropic.claudefordesktop",
    "priorKeys": {
      "coworkEgressAllowedHosts": ["github.com", "*.github.com"]
    }
  }
}
```

`configure-claude-desktop` writes this file *before* mutating any keys.
Apply behaviour unchanged: write our 16-key default profile, clear MDM
`coworkEgressAllowedHosts`.

`uninstall --force` reads the snapshot and:

1. For each key in `fileTier.priorKeys`: if `__UNSET__`, remove from JSON;
   else write back the prior value.
2. For each key in `mdmTier.priorKeys`: re-write to the defaults DB via
   `defaults write` (or delete if `__UNSET__`).
3. Delete the snapshot file.

If the snapshot is missing (an older install), fall back to the current
strip-our-keys behaviour and emit a warning that MDM-tier values weren't
restored.

## Acceptance

- `configure-claude-desktop` followed by `uninstall --force` on a
  machine that previously had `coworkEgressAllowedHosts: ["github.com"]`
  in its MDM tier *restores* that array. Verified by `defaults read` after
  the round-trip.

## Open questions

1. Should the snapshot file include a timestamp-suffixed history (one
   snapshot per `configure-claude-desktop` run)? Probably not — one is
   enough for revert; history is cheap to add later if needed.
2. What if `configure-claude-desktop --revert` is invoked from a snapshot
   created by a *different* user? Scope the snapshot to current user's
   home; `${COPILOT_API_HOME}` already does that.
3. The MDM-tier write is the sharp edge: nothing in `src/` shells out to
   `defaults` today, and restoring a key we never cleared would be worse
   than leaving it. Confirm the apply side actually clears it before
   building the restore side.
