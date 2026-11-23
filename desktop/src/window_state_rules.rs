//! What the window's state was since the app opened (YN-221 S8), with no
//! dependencies, so CI checks it without building a desktop app (as
//! `badge_rules.rs`). `window_state.rs` feeds it the window's events and
//! answers `desktop_window_state` from it, for Copy diagnostics.
//!
//! A state is visible, minimized or hidden (not shown at all: closed to the
//! tray, or before the window first shows). A window another covers is still
//! visible here: the system does not tell the app. The log keeps the last
//! `KEPT` changes with their time since the app opened, and how long the
//! window was in each state; a state reported again is no change.

/// The changes kept, the newest last.
pub const KEPT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Visible,
    Minimized,
    Hidden,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Visible => "visible",
            State::Minimized => "minimized",
            State::Hidden => "hidden",
        }
    }

    /// The state the window is in, from what the system says of it.
    pub fn of(shown: bool, minimized: bool) -> State {
        if !shown {
            State::Hidden
        } else if minimized {
            State::Minimized
        } else {
            State::Visible
        }
    }

    fn index(self) -> usize {
        match self {
            State::Visible => 0,
            State::Minimized => 1,
            State::Hidden => 2,
        }
    }
}

/// One change: when (milliseconds since the app opened) and to what.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    pub since_start_ms: u64,
    pub state: State,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Log {
    state: State,
    focused: bool,
    since_ms: u64,
    totals_ms: [u64; 3],
    changes: Vec<Change>,
    dropped: u64,
}

/// The log as it stands at a moment: the totals include the time since the
/// last change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub state: State,
    pub focused: bool,
    pub visible_ms: u64,
    pub minimized_ms: u64,
    pub hidden_ms: u64,
    pub changes: Vec<Change>,
    pub dropped: u64,
}

impl Log {
    /// The log from the app's start (`at_ms`), in `state`.
    pub fn new(at_ms: u64, state: State, focused: bool) -> Log {
        Log {
            state,
            focused,
            since_ms: at_ms,
            totals_ms: [0; 3],
            changes: vec![Change { since_start_ms: at_ms, state }],
            dropped: 0,
        }
    }

    /// The window is in `state` at `at_ms`; a change only if it differs.
    /// A time before the last change (a clock that went back) counts as it.
    pub fn note(&mut self, at_ms: u64, state: State) -> bool {
        if state == self.state {
            return false;
        }
        let at_ms = at_ms.max(self.since_ms);
        self.totals_ms[self.state.index()] += at_ms - self.since_ms;
        self.state = state;
        self.since_ms = at_ms;
        self.changes.push(Change { since_start_ms: at_ms, state });
        if self.changes.len() > KEPT {
            self.changes.remove(0);
            self.dropped += 1;
        }
        true
    }

    pub fn focus(&mut self, focused: bool) {
        self.focused = focused;
    }

    pub fn report(&self, now_ms: u64) -> Report {
        let mut totals = self.totals_ms;
        totals[self.state.index()] += now_ms.saturating_sub(self.since_ms);
        Report {
            state: self.state,
            focused: self.focused,
            visible_ms: totals[0],
            minimized_ms: totals[1],
            hidden_ms: totals[2],
            changes: self.changes.clone(),
            dropped: self.dropped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_from_what_the_system_says() {
        assert_eq!(State::of(true, false), State::Visible);
        assert_eq!(State::of(true, true), State::Minimized);
        // Not shown at all, whatever else it says.
        assert_eq!(State::of(false, true), State::Hidden);
        assert_eq!(State::of(false, false), State::Hidden);
    }

    #[test]
    fn changes_and_how_long_in_each() {
        let mut log = Log::new(0, State::Visible, true);
        assert!(log.note(1_000, State::Minimized));
        assert!(log.note(4_000, State::Visible));
        assert!(log.note(4_500, State::Hidden));
        log.focus(false);
        let report = log.report(10_000);
        assert_eq!((report.visible_ms, report.minimized_ms, report.hidden_ms), (1_500, 3_000, 5_500));
        assert_eq!(report.state, State::Hidden);
        assert!(!report.focused);
        assert_eq!(
            report.changes.iter().map(|c| (c.since_start_ms, c.state)).collect::<Vec<_>>(),
            vec![(0, State::Visible), (1_000, State::Minimized), (4_000, State::Visible), (4_500, State::Hidden)]
        );
    }

    #[test]
    fn the_same_state_again_is_no_change() {
        let mut log = Log::new(0, State::Visible, true);
        assert!(!log.note(500, State::Visible));
        assert!(log.note(1_000, State::Minimized));
        assert!(!log.note(2_000, State::Minimized));
        let report = log.report(3_000);
        assert_eq!(report.changes.len(), 2);
        assert_eq!((report.visible_ms, report.minimized_ms), (1_000, 2_000));
    }

    #[test]
    fn only_the_newest_changes_are_kept() {
        let mut log = Log::new(0, State::Visible, true);
        for i in 1..=40u64 {
            log.note(i * 10, if i % 2 == 1 { State::Minimized } else { State::Visible });
        }
        let report = log.report(500);
        assert_eq!(report.changes.len(), KEPT);
        assert_eq!(report.dropped, 41 - KEPT as u64);
        assert_eq!(report.changes.last().map(|c| c.since_start_ms), Some(400));
        // The totals still cover the whole time.
        assert_eq!(report.visible_ms + report.minimized_ms + report.hidden_ms, 500);
    }

    #[test]
    fn a_clock_that_goes_back_adds_no_negative_time() {
        let mut log = Log::new(1_000, State::Visible, true);
        assert!(log.note(500, State::Minimized));
        let report = log.report(400);
        assert_eq!((report.visible_ms, report.minimized_ms), (0, 0));
    }
}
