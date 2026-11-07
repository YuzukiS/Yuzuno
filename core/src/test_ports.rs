//! Free loopback ports for tests, shared by every test module that needs
//! one (YN-20). A port found by binding port 0 and released can be offered
//! again by the next bind: CI gave 40321 twice in a row (remote_access), and
//! an updates::start test was given Core's own port as its remote entry's
//! (run 42396773657). Two ports taken one after the other that way can be
//! one port.

/// Ports `free_port` has handed out in this test process.
static GIVEN_PORTS: std::sync::Mutex<std::collections::BTreeSet<u16>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// A free loopback port, never one this test process was given before: the
/// ports a test takes (Core's own and its remote entry's, a phone entry and a
/// previews entry, sshd's and a closed one) always differ, however it takes
/// them. Released before it is returned, for the code under test to bind;
/// between the two another process could still take it, a race this does
/// not remove.
pub(crate) fn free_port() -> u16 {
    distinct_port(&mut GIVEN_PORTS.lock().unwrap_or_else(|e| e.into_inner()), || {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        (listener.local_addr().unwrap().port(), listener)
    })
}

/// A port `bind` finds that is not in `given`, which then holds it too. The
/// OS can offer a port it just let go of again (CI gave 40321 twice in a
/// row). One already given is kept bound (its guard held) while `bind` is
/// asked again, so the OS cannot offer it again; each try holds a different
/// given port, so it ends within `given.len() + 1` tries. Every guard is
/// dropped before returning.
fn distinct_port<G>(given: &mut std::collections::BTreeSet<u16>, mut bind: impl FnMut() -> (u16, G)) -> u16 {
    let mut held = Vec::new();
    loop {
        let (port, guard) = bind();
        if given.insert(port) {
            drop(guard);
            return port;
        }
        held.push(guard);
        assert!(held.len() <= given.len(), "bind offered {} ports already given, while every earlier one was still held", held.len());
    }
}

#[test]
fn free_port_never_gives_one_port_twice_even_when_it_is_offered_again() {
    // The OS offering the ports it just let go of, as in CI (40321 twice in a
    // row). Handing out each first offer, as free_port did, would give a test
    // 40321 for both its entries. A port still held is not offered again, as
    // the OS would not: each call's repeats differ from one another.
    let offers = [40321, 40321, 40322, 40321, 40322, 40323];
    // Each guard counts itself while bound.
    struct Bound<'a>(&'a std::cell::Cell<usize>);
    impl Drop for Bound<'_> {
        fn drop(&mut self) {
            self.0.set(self.0.get() - 1);
        }
    }
    let live = std::cell::Cell::new(0);
    let mut next = offers.into_iter();
    let mut bind = || {
        live.set(live.get() + 1);
        (next.next().expect("asked once too often"), Bound(&live))
    };
    let mut given = std::collections::BTreeSet::new();
    assert_eq!(distinct_port(&mut given, &mut bind), 40321);
    assert_eq!(live.get(), 0, "released for the code under test");
    // A repeat of 40321 is held while it asks again, then let go.
    assert_eq!(distinct_port(&mut given, &mut bind), 40322);
    assert_eq!(live.get(), 0, "the held repeat released too");
    // Both earlier ports offered again: both held, a third port given, all let go.
    assert_eq!(distinct_port(&mut given, &mut bind), 40323);
    assert_eq!(live.get(), 0, "every held repeat released");
    assert!(next.next().is_none(), "asked exactly as often as needed");
    // And for real: every port free_port hands out in this process is its own.
    let ports: Vec<u16> = (0..64).map(|_| free_port()).collect();
    let distinct: std::collections::BTreeSet<u16> = ports.iter().copied().collect();
    assert_eq!(distinct.len(), ports.len(), "{ports:?}");
}

#[test]
fn free_port_fails_plainly_when_bind_only_offers_ports_already_given() {
    // A bind no OS has: it offers 7 again while 7 is still held. This ends in a
    // panic on its second try, never a loop for ever.
    let refused = std::panic::catch_unwind(|| {
        let mut given = std::collections::BTreeSet::from([7]);
        distinct_port(&mut given, || (7, ()))
    });
    assert!(refused.is_err());
}
