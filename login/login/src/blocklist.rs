//! Static login-deny blocklist (defense-in-depth).
//!
//! A **global** (not per-client) list of blocked Ethereum addresses that DENY
//! login regardless of the relying party. The list is read from a JSON file
//! (`BLOCKLIST_FILE`, default `/config/blocklist.json`) — a flat JSON array of
//! `0x`-prefixed address strings, e.g. `["0xabc…","0xdef…"]`. Like token-gating
//! (`restrictions.rs`), the file is **re-read per request** so a ConfigMap edit
//! applies without a pod restart.
//!
//! Matching is **case-insensitive** (EIP-55 checksum casing is irrelevant): both
//! the candidate address and each list entry are lowercased before comparison.
//!
//! **Fail open on a missing/empty/unparseable file** ⇒ the blocklist is empty
//! and nobody is blocked. A missing file must NOT block everyone (that would take
//! down all logins); a malformed file is logged at `warn!` and treated as empty,
//! mirroring how `restrictions.rs` degrades on a bad fallback file.

use std::path::Path;

/// Normalize an address for comparison: trim surrounding whitespace and
/// lowercase. The `0x` prefix is left intact (both sides are normalized the same
/// way, so the prefix matches the prefix); lowercasing makes EIP-55 checksum
/// casing irrelevant.
fn normalize(address: &str) -> String {
    address.trim().to_ascii_lowercase()
}

/// True if `address` appears in the blocklist file at `file`.
///
/// Comparison is case-insensitive (both sides lowercased). The file is read
/// fresh on every call. A missing / empty / unparseable file yields `false`
/// (empty blocklist — fail open) so a misconfigured or absent file never blocks
/// legitimate logins; a parse error is logged at `warn!`.
pub fn is_blocked(address: &str, file: &Path) -> bool {
    let candidate = normalize(address);
    if candidate.is_empty() {
        return false;
    }

    // Read every request on purpose (ConfigMap edits apply without a restart).
    // A missing/unreadable file ⇒ empty blocklist (fail open, no warn — absence
    // is a normal "no blocklist configured" state).
    let contents = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(_) => return false,
    };

    // An empty/whitespace-only file is a no-op (no entries).
    if contents.trim().is_empty() {
        return false;
    }

    // A malformed file ⇒ empty blocklist (fail open) + a warn!, like
    // restrictions.rs does for its fallback JSON.
    let entries: Vec<String> = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("invalid blocklist {}: {e}", file.display());
            return false;
        }
    };

    entries.iter().any(|entry| normalize(entry) == candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `contents` to a uniquely-named temp file and return its path. The
    /// file persists for the test process (cleaned up by the OS temp dir).
    fn temp_file(contents: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "blocklist-test-{}-{}.json",
            std::process::id(),
            // A monotonic-ish suffix so concurrent tests don't collide.
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        let mut f = std::fs::File::create(&path).expect("create temp blocklist");
        f.write_all(contents.as_bytes())
            .expect("write temp blocklist");
        path
    }

    #[test]
    fn blocked_address_matches_case_insensitively() {
        // List stored lowercase; candidate given with EIP-55 checksum casing.
        let path = temp_file(
            r#"["0xab5801a7d398351b8be11c439e05c5b3259aec9b",
                "0x742d35cc6634c0532925a3b844bc454e4438f44e"]"#,
        );
        // Exact lowercase match.
        assert!(is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        // Checksum-cased candidate (Vitalik's address casing) still matches.
        assert!(is_blocked(
            "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
            &path
        ));
        // Uppercased candidate matches a lowercase list entry.
        assert!(is_blocked(
            "0X742D35CC6634C0532925A3B844BC454E4438F44E",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn blocked_match_when_list_entry_is_checksum_cased() {
        // List entry itself is checksum-cased; lowercase candidate matches.
        let path = temp_file(r#"["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"]"#);
        assert!(is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn non_blocked_address_does_not_match() {
        let path = temp_file(r#"["0xab5801a7d398351b8be11c439e05c5b3259aec9b"]"#);
        assert!(!is_blocked(
            "0x0000000000000000000000000000000000000001",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_does_not_block() {
        // A path that does not exist ⇒ fail open (empty blocklist).
        let path = std::path::Path::new("/nonexistent/blocklist-does-not-exist.json");
        assert!(!is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            path
        ));
    }

    #[test]
    fn empty_file_does_not_block() {
        let path = temp_file("");
        assert!(!is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_json_array_does_not_block() {
        let path = temp_file("[]");
        assert!(!is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn malformed_json_does_not_block() {
        // Not a JSON array of strings ⇒ parse error ⇒ fail open (warn + false).
        let path = temp_file(r#"{"not":"an array"}"#);
        assert!(!is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        std::fs::remove_file(&path).ok();

        let path = temp_file("this is not json at all");
        assert!(!is_blocked(
            "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
            &path
        ));
        std::fs::remove_file(&path).ok();
    }
}
