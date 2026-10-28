//! Process identity from `/proc/<pid>/stat`.

/// The start time in clock ticks, field 22 of `/proc/<pid>/stat`. The
/// command name may hold spaces and parentheses, so fields are counted
/// after its last `)`.
pub fn parse_start_ticks(stat: &str) -> Option<u64> {
    let (_, rest) = stat.rsplit_once(')')?;
    // The first field after the name is field 3, so field 22 is index 19.
    rest.split_whitespace().nth(19)?.parse().ok()
}

/// The start ticks of a live process, or `None` when it is gone.
pub fn read_start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_start_ticks(&stat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_field_22() {
        let stat = "4242 (Xvfb) S 1 4242 4242 0 -1 4194560 1540 0 0 0 12 3 0 0 20 0 1 0 987654 \
                    226168832 4377 18446744073709551615 1 1 0 0 0 0 0 4096 16384 0 0 0 17 3 0 0 0 0 0";
        assert_eq!(parse_start_ticks(stat), Some(987654));
    }

    #[test]
    fn survives_odd_command_names() {
        let stat = "7 (a) b (c d)) R 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0";
        assert_eq!(parse_start_ticks(stat), Some(55));
    }

    #[test]
    fn rejects_short_or_bad_input() {
        assert_eq!(parse_start_ticks(""), None);
        assert_eq!(parse_start_ticks("1 (x) S 1 2 3"), None);
        assert_eq!(
            parse_start_ticks("1 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 nope 0"),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_own_process() {
        assert!(read_start_ticks(std::process::id()).is_some());
        assert_eq!(read_start_ticks(0), None);
    }
}
