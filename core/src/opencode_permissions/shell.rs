//! The directory changes a shell command states, read conservatively
//! (YN-78 S4a; design v4 2.3.2 rule 3).
//!
//! OpenCode 2.2.5 asks for a shell call's working folder and for each
//! directory its own parser finds (core/src/shell/parse.ts: `cd`, `chdir`,
//! `pushd`, `popd`, `push-location`, `set-location` heads). That parser
//! rests on a scanner not among the fixed sources, so Core doesn't copy it.
//! It reads a small subset of the shell instead, in which it can name every
//! directory change, and refuses the rest:
//! - Words, `'…'` and `"…"` (without `$`, a backtick or `\` inside),
//!   separated by `;`, `&`, `&&`, `|`, `||`, `|&` or a new line, and output
//!   redirections (`>`, `>>`, `>|`, `>&`, with an fd). A redirection's target
//!   is not a command's word.
//! - No `$`, backtick, `\`, `(`, `)`, `{`, `}`, `#`, `<` or `&>` anywhere,
//!   and no control character but a tab or a new line. So there is no
//!   expansion, substitution, subshell, group, function, comment or here
//!   document.
//! - A directory change is a simple command whose head (after any `NAME=`
//!   words) is one of `CHANGES`. A name of `CHANGES` anywhere else (an
//!   argument, `eval cd …`, `builtin cd`, `if …; then cd …`, an alias's
//!   text) can change the directory unseen, so it is refused.
//! - A change names one directory: not none, not an option, not `-`, not a
//!   stack entry (`popd`, `+1`), written bare or as one quoted part (shells
//!   join and read quotes differently). An absolute one may be anywhere. `~`,
//!   `~/…` and a relative one (only `.`, `..`, `./…` or `../…`, which CDPATH
//!   never applies to) only in the command's first simple command, without
//!   `NAME=` words before it: later, an earlier command could have changed
//!   the directory or HOME.
//!
//! What this covers is the directory changes the command itself states. A
//! script it runs, a shell startup file (`BASH_ENV`, `.zshenv`) or a program
//! is not read, and the shell itself has no sandbox: this decides OpenCode's
//! directory question, it does not confine the command.

/// The heads that change the shell's directory: OpenCode 2.2.5's (parse.ts
/// `CWD`), and PowerShell's `sl` and `pop-location`, in any case.
const CHANGES: [&str; 8] = ["cd", "chdir", "pushd", "popd", "push-location", "set-location", "sl", "pop-location"];

/// A directory a command changes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Change {
    /// An absolute path, as written.
    Absolute(String),
    /// `~` (an empty rest) or `~/rest`, in the first command.
    Home(String),
    /// `.`, `..`, `./…` or `../…`, in the first command.
    Relative(String),
}

/// One shell word: its text with quotes taken out, and how it was written.
#[derive(Clone, Debug, Default)]
struct Word {
    text: String,
    /// Whether any of it was not quoted.
    bare: bool,
    /// How many quoted parts it has.
    quoted: usize,
    /// It starts with a bare `~`, `=`, or has a bare `*`, `?` or `[`.
    tilde: bool,
    equals: bool,
    glob: bool,
}

enum Token {
    Word(Word),
    Separator,
    Redirection,
}

/// Every directory change `command` states, in order, or None when it isn't
/// in the subset Core reads.
pub(super) fn changes(command: &str) -> Option<Vec<Change>> {
    let commands = commands(&tokens(command)?)?;
    let mut found = Vec::new();
    for (index, words) in commands.iter().enumerate() {
        let head = words.iter().position(|word| !assignment(word));
        // Any name of a change but the head's could change the directory unseen.
        if words.iter().enumerate().any(|(at, word)| Some(at) != head && mentions_change(&word.text)) {
            return None;
        }
        let Some(head) = head else { continue };
        let lower = words[head].text.to_lowercase();
        if !CHANGES.contains(&lower.as_str()) {
            continue;
        }
        if lower == "popd" || lower == "pop-location" {
            return None;
        }
        let [operand] = &words[head + 1..] else { return None };
        found.push(change(operand, index == 0 && head == 0)?);
    }
    Some(found)
}

/// The change `operand` names, `first` when it is in the first command with
/// nothing before its head.
fn change(operand: &Word, first: bool) -> Option<Change> {
    let text = operand.text.as_str();
    if text.is_empty() || text.starts_with(['-', '+']) || operand.quoted > 1 || (operand.bare && operand.quoted > 0) {
        return None;
    }
    if operand.bare {
        // Only plain characters: no glob, no zsh `=command`, no other tilde.
        let plain = |c: char| c.is_alphanumeric() || "._-/+,@%:".contains(c);
        if operand.glob || operand.equals || !text.chars().enumerate().all(|(at, c)| plain(c) || (c == '~' && at == 0)) {
            return None;
        }
        if operand.tilde {
            return match (first, text) {
                (true, "~") => Some(Change::Home(String::new())),
                (true, _) => text.strip_prefix("~/").map(|rest| Change::Home(rest.to_owned())),
                (false, _) => None,
            };
        }
    } else if text.starts_with('~') {
        // A quoted `~` is a folder named `~` to the shell, but OpenCode expands it.
        return None;
    }
    if text.starts_with('/') {
        return Some(Change::Absolute(text.to_owned()));
    }
    let relative = text == "." || text == ".." || text.starts_with("./") || text.starts_with("../");
    (first && relative).then(|| Change::Relative(text.to_owned()))
}

/// Whether a bare word sets a variable (`NAME=…`).
fn assignment(word: &Word) -> bool {
    if word.quoted > 0 {
        return false;
    }
    let Some((name, _)) = word.text.split_once('=') else { return false };
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether text names a change as a whole word: a run of letters, digits,
/// `_` and `-` equal to one of `CHANGES`, in any case.
fn mentions_change(text: &str) -> bool {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .any(|run| CHANGES.contains(&run.to_lowercase().as_str()))
}

/// The words and separators of `command`, or None for anything outside the subset.
fn tokens(command: &str) -> Option<Vec<Token>> {
    let chars: Vec<char> = command.chars().collect();
    let mut tokens = Vec::new();
    let mut word: Option<Word> = None;
    let end = |word: &mut Option<Word>, tokens: &mut Vec<Token>| {
        if let Some(word) = word.take() {
            tokens.push(Token::Word(word));
        }
    };
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        match c {
            ' ' | '\t' => end(&mut word, &mut tokens),
            '\n' | ';' => {
                end(&mut word, &mut tokens);
                tokens.push(Token::Separator);
            }
            '&' | '|' => {
                end(&mut word, &mut tokens);
                match (c, next) {
                    ('&', Some('>')) => return None,
                    ('&', Some('&')) | ('|', Some('|' | '&')) => at += 1,
                    _ => {}
                }
                tokens.push(Token::Separator);
            }
            '>' => {
                // A bare number just before it is the fd it redirects, not a word.
                match word.take() {
                    Some(fd) if fd.quoted == 0 && !fd.text.is_empty() && fd.text.bytes().all(|b| b.is_ascii_digit()) => {}
                    other => {
                        word = other;
                        end(&mut word, &mut tokens);
                    }
                }
                if matches!(next, Some('>' | '|' | '&')) {
                    at += 1;
                }
                tokens.push(Token::Redirection);
            }
            '\'' | '"' => {
                let close = chars[at + 1..].iter().position(|&q| q == c)? + at + 1;
                let inside: String = chars[at + 1..close].iter().collect();
                if inside.chars().any(|q| q.is_control() && q != '\t' && q != '\n')
                    || (c == '"' && inside.contains(['$', '`', '\\'])) {
                    return None;
                }
                let word = word.get_or_insert_with(Word::default);
                word.text.push_str(&inside);
                word.quoted += 1;
                at = close;
            }
            '$' | '`' | '\\' | '(' | ')' | '{' | '}' | '#' | '<' => return None,
            c if c.is_control() => return None,
            c => {
                let word = word.get_or_insert_with(Word::default);
                if word.text.is_empty() && word.quoted == 0 {
                    word.tilde = c == '~';
                    word.equals = c == '=';
                }
                word.glob |= matches!(c, '*' | '?' | '[');
                word.bare = true;
                word.text.push(c);
            }
        }
        at += 1;
    }
    end(&mut word, &mut tokens);
    Some(tokens)
}

/// The simple commands of `tokens`, each its words without redirection
/// targets; None for a redirection with no target.
fn commands(tokens: &[Token]) -> Option<Vec<Vec<Word>>> {
    let (mut commands, mut words, mut target) = (Vec::new(), Vec::new(), false);
    for token in tokens {
        match token {
            Token::Word(word) if !target => words.push(word.clone()),
            Token::Word(_) => target = false,
            Token::Redirection if target => return None,
            Token::Redirection => target = true,
            Token::Separator if target => return None,
            Token::Separator => {
                if !words.is_empty() {
                    commands.push(std::mem::take(&mut words));
                }
            }
        }
    }
    if target {
        return None;
    }
    if !words.is_empty() {
        commands.push(words);
    }
    Some(commands)
}
