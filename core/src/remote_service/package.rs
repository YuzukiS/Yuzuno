//! The bytes Core installs on a remote machine, and the command that starts it.

use crate::remote::{shell_quote, ssh_with_control, Control, RemoteMachine};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use tokio::process::Command;

/// The program boot.py installs: a fixed header and the session source. The
/// header is part of the file, so the digest a session reports is the digest
/// of the installed file.
const HEADER: &str = "# yuzuno-remote protocol 1\n";

pub(crate) const BOOT: &str = include_str!("boot.py");
pub(crate) const PROGRAM: &str = include_str!("program.py");

static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
static DIGEST: OnceLock<String> = OnceLock::new();

pub(crate) fn bytes() -> &'static [u8] {
    BYTES.get_or_init(|| {
        let mut bytes = Vec::with_capacity(HEADER.len() + PROGRAM.len());
        bytes.extend_from_slice(HEADER.as_bytes());
        bytes.extend_from_slice(PROGRAM.as_bytes());
        bytes
    })
}

pub(crate) fn digest() -> &'static str {
    DIGEST.get_or_init(|| {
        let mut hash = Sha256::new();
        hash.update(bytes());
        format!("{:x}", hash.finalize())
    })
}

pub(crate) fn size() -> usize {
    bytes().len()
}

/// The one SSH command that starts a session on `machine`: fixed code only,
/// never a value from the machine in the remote command.
pub(crate) fn boot_command(machine: &RemoteMachine) -> Command {
    boot_command_with("ssh", machine)
}

/// The same through another program with ssh's argument conventions (a
/// test's stand-in, or a wrapper with its own configuration).
pub(super) fn boot_command_with(program: &str, machine: &RemoteMachine) -> Command {
    let mut command = ssh_with_control(program, Control::Off);
    command
        .args(["-o", "ClearAllForwardings=yes"])
        .arg(&machine.target)
        .arg(format!("python3 -c {}", shell_quote(BOOT)));
    command
}
