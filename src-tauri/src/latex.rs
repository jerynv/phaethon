//! LaTeX documents and TikZ figures from a reply, compiled on this computer
//! into PDFs the chat shows (a document card's View, a ```tikz figure) and
//! Save to space writes beside the source.
//!
//! The TeX is written by a model, so it is untrusted: a document can ask TeX
//! to read any file it can name (`\input{/etc/passwd}`; TeX Live 2026 made
//! `openin_any` a no-op, so kpathsea no longer stops that), to write files,
//! to run programs (`\write18`), and to loop for ever. The walls:
//!
//! - a fresh, private folder per compile, removed afterwards; TeX runs in it
//!   with `HOME`, `TMPDIR`, `TEXMFOUTPUT` and `TEXMFCACHE` pointed there and
//!   an otherwise empty environment (no `$VAR` to expand into a path);
//! - `-no-shell-escape`, `shell_escape=f`, `openout_any=p` (no writes to
//!   dotfiles, parent folders or absolute paths), nonstop, halt on error;
//! - on macOS, `sandbox-exec` with a profile that denies the network, every
//!   write outside the compile folder, running anything but TeX's own
//!   programs (and the shell xelatex starts xdvipdfmx with), and reading
//!   user data: `/Users`, `/Volumes`, `/private/etc`, the temp folders and
//!   `/private/var/root`, except the compile folder and TeX's own trees in the
//!   home folder (`TEXMFHOME`, `TEXMFVAR`, `TEXMFCONFIG`) and `~/Library/Fonts`;
//! - one minute at most, then the whole process group is killed; each file
//!   TeX writes is capped (`RLIMIT_FSIZE`), and so is the PDF read back.
//!
//! Without a sandbox (any platform but macOS, for now) nothing is compiled:
//! the card says so and still shows the source.
//!
//! Compiled PDFs are cached by a hash of the engine, the kind and the source
//! in the app's cache folder, so showing a message again never recompiles.
//! One compile runs at a time.

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::tools;

/// The longest source compiled.
pub const MAX_SOURCE: usize = 512 * 1024;
/// The largest PDF read back.
pub const MAX_PDF: u64 = 40 * 1024 * 1024;
/// The largest file TeX may write (log, aux, PDF): `RLIMIT_FSIZE`.
#[cfg(target_os = "macos")]
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// How long one compile (all its runs) may take.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// Runs for references and contents to settle.
const MAX_RUNS: usize = 3;
/// How much of the log comes back with an error.
const MAX_LOG: usize = 48 * 1024;
/// Cached PDFs kept; the oldest go first.
const MAX_CACHED: usize = 200;

/// Where the plain-words install hint points.
pub const INSTALL_HINT: &str = "To see LaTeX documents here, install a TeX distribution: MacTeX on a Mac (tug.org/mactex), \
TeX Live on Linux or Windows (tug.org/texlive), or tectonic (tectonic-typesetting.github.io). Then open this again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pdflatex,
    Xelatex,
    Lualatex,
    Tectonic,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::Pdflatex, Kind::Xelatex, Kind::Lualatex, Kind::Tectonic];

    fn bin(self) -> &'static str {
        match self {
            Kind::Pdflatex => "pdflatex",
            Kind::Xelatex => "xelatex",
            Kind::Lualatex => "lualatex",
            Kind::Tectonic => "tectonic",
        }
    }

    /// The engine's name for people.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Pdflatex => "pdfLaTeX",
            Kind::Xelatex => "XeLaTeX",
            Kind::Lualatex => "LuaLaTeX",
            Kind::Tectonic => "Tectonic",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Engine {
    pub kind: Kind,
    pub path: PathBuf,
}

/// Where TeX is installed but not on `PATH` for an app opened from Finder.
fn tex_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Library/TeX/texbin")];
    // /usr/local/texlive/<year>/bin/<platform>, newest year first.
    if let Ok(rd) = fs::read_dir("/usr/local/texlive") {
        let mut years: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path().join("bin")).filter(|p| p.is_dir()).collect();
        years.sort();
        for bin in years.into_iter().rev() {
            if let Ok(rd) = fs::read_dir(&bin) {
                dirs.extend(rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()));
            }
        }
    }
    dirs.extend(crate::agent::common_bin_dirs());
    if let Some(home) = crate::vault::home_dir() {
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.push(PathBuf::from("/usr/bin"));
    dirs
}

/// Every engine on this computer, in the order they are preferred.
pub fn engines() -> Vec<Engine> {
    let extra = tex_dirs();
    Kind::ALL
        .iter()
        .filter_map(|&kind| crate::agent::find_on_path(kind.bin(), &extra).map(|path| Engine { kind, path }))
        .collect()
}

/// The engine for `source`: pdfLaTeX for most documents (the fastest, and
/// what most LaTeX is written for); XeLaTeX or LuaLaTeX when the document
/// loads system fonts (fontspec, unicode-math, polyglossia); LuaLaTeX when it
/// runs Lua. Falls back to whatever is installed.
pub fn choose(engines: &[Engine], source: &str) -> Option<Engine> {
    let has = |s: &str| source.contains(s);
    let order: &[Kind] = if has("\\directlua") || has("{luacode") {
        &[Kind::Lualatex, Kind::Tectonic]
    } else if has("{fontspec}") || has("{unicode-math}") || has("{polyglossia}") || has("\\setmainfont") {
        &[Kind::Xelatex, Kind::Lualatex, Kind::Tectonic]
    } else {
        &[Kind::Pdflatex, Kind::Xelatex, Kind::Lualatex, Kind::Tectonic]
    };
    order
        .iter()
        .chain(Kind::ALL.iter())
        .find_map(|k| engines.iter().find(|e| e.kind == *k))
        .cloned()
}

// ---- Figures ----------------------------------------------------------------

/// Whether `source` is a whole document rather than a figure's body.
pub fn is_document(source: &str) -> bool {
    source.contains("\\documentclass")
}

/// A ```tikz figure as a document whose one page is the figure, cropped with
/// a small margin (no `standalone` class: a basic TeX install lacks it).
/// `\usepackage`, `\usetikzlibrary` and `\usepgfplotslibrary` lines move to the
/// preamble (blank lines stay, so line numbers still match). Returns the
/// document and how many lines come before the figure's first line.
pub fn figure_document(body: &str) -> (String, u32) {
    let mut preamble = vec![
        "\\documentclass{article}".to_string(),
        "\\usepackage{amsmath,amssymb}".to_string(),
        "\\usepackage{tikz}".to_string(),
        "\\usetikzlibrary{arrows.meta,calc,positioning,decorations.pathreplacing,shapes.geometric,patterns,angles,quotes,backgrounds,fit}".to_string(),
    ];
    if ["\\begin{axis}", "pgfplots", "\\addplot", "{semilogxaxis}", "{loglogaxis}", "{polaraxis}"].iter().any(|s| body.contains(s)) {
        preamble.push("\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}".into());
    }
    let mut lines: Vec<String> = vec![];
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("\\usepackage") || t.starts_with("\\usetikzlibrary") || t.starts_with("\\usepgfplotslibrary") || t.starts_with("\\pgfplotsset") {
            preamble.push(line.to_string());
            lines.push(String::new());
        } else {
            lines.push(line.to_string());
        }
    }
    let body = lines.join("\n");
    let wrapped = !body.contains("\\begin{tikzpicture}");
    preamble.push("\\pagestyle{empty}".into());
    preamble.push("\\begin{document}".into());
    preamble.push("\\setbox0=\\hbox{%".into());
    if wrapped {
        preamble.push("\\begin{tikzpicture}".into());
    }
    let before = preamble.len() as u32;
    let mut doc = preamble.join("\n");
    doc.push('\n');
    doc.push_str(&body);
    doc.push('\n');
    if wrapped {
        doc.push_str("\\end{tikzpicture}");
    }
    doc.push_str(
        "%\n}%\n\\ifdefined\\pdfpagewidth\\pdfpagewidth=\\dimexpr\\wd0+8pt\\relax\\pdfpageheight=\\dimexpr\\ht0+\\dp0+8pt\\relax\
\\else\\pagewidth=\\dimexpr\\wd0+8pt\\relax\\pageheight=\\dimexpr\\ht0+\\dp0+8pt\\relax\\fi\n\
\\hoffset=-1in \\voffset=-1in\n\\shipout\\vbox{\\kern4pt\\hbox{\\kern4pt\\box0\\kern4pt}\\kern4pt}\n\\end{document}\n",
    );
    (doc, before)
}

// ---- Errors -----------------------------------------------------------------

/// Why a compile made no PDF.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// The document has an error: in plain words, with its line in the source.
    Error { message: String, line: Option<u32>, log: String },
    /// It ran past the time limit and was stopped.
    Timeout { log: String },
    /// Something around TeX went wrong (no sandbox, a folder, a spawn).
    Setup(String),
}

/// The first error in a TeX log in plain words, and its line in the source
/// (`offset` lines before the source's first are taken off).
pub fn parse_error(log: &str, offset: u32) -> (String, Option<u32>) {
    let lines: Vec<&str> = log.lines().collect();
    let Some(at) = lines.iter().position(|l| l.starts_with("! ")) else {
        if log.contains("No pages of output") {
            return ("The document has nothing to show: it made no pages.".into(), None);
        }
        return ("LaTeX couldn’t make a PDF of this document. The log says more.".into(), None);
    };
    let raw = lines[at][2..].trim().to_string();
    let mut line = None;
    let mut context = "";
    for l in lines.iter().skip(at + 1).take(40) {
        if let Some(rest) = l.strip_prefix("l.") {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u32>() {
                line = (n > offset).then(|| n - offset);
                context = rest[digits.len()..].trim();
                break;
            }
        }
    }
    let at_line = line.map(|n| format!(" (line {n})")).unwrap_or_default();
    let near = line.map(|n| format!(" near line {n}")).unwrap_or_default();
    if let Some(file) = raw.strip_prefix("LaTeX Error: File `").and_then(|r| r.split('\'').next()) {
        let stem = file.trim_end_matches(".sty").trim_end_matches(".cls");
        if file.ends_with(".sty") || file.ends_with(".cls") {
            return (
                format!("The LaTeX package “{stem}” isn’t installed on this computer{at_line}. With TeX Live or MacTeX, “tlmgr install {stem}” adds it."),
                line,
            );
        }
        return (
            format!("The document asks for the file “{file}”{at_line}, which isn’t there: a document here compiles on its own, without other files."),
            line,
        );
    }
    if raw.starts_with("Undefined control sequence") {
        let cmd = context
            .rsplit('\\')
            .next()
            .map(|c| c.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '@').collect::<String>())
            .filter(|c| !c.is_empty());
        return match cmd {
            Some(c) => (format!("LaTeX doesn’t know the command \\{c}{at_line}. It may need a package the document doesn’t load, or be a typo."), line),
            None => (format!("LaTeX doesn’t know a command{at_line}. It may need a package the document doesn’t load, or be a typo."), line),
        };
    }
    if raw.starts_with("Missing $ inserted") {
        return (format!("Something that only works in math (like ^, _ or \\alpha) is outside $…${near}."), line);
    }
    if raw.starts_with("I can't write on file") || raw.starts_with("I can’t write on file") {
        return ("The document tried to write a file outside its own folder, which isn’t allowed here.".into(), line);
    }
    if raw.starts_with("Emergency stop") || raw.starts_with("==> Fatal error") {
        return (format!("LaTeX stopped early{near}: the document ended before it was complete."), line);
    }
    let raw = raw.trim_end_matches('.');
    (format!("LaTeX stopped{near}: {raw}."), line)
}

/// Whether another run would settle references, contents or page counts.
fn needs_rerun(log: &str, source: &str) -> bool {
    log.contains("Rerun to get")
        || log.contains("Label(s) may have changed")
        || log.contains("Rerun LaTeX")
        || ["\\tableofcontents", "\\listoffigures", "\\listoftables", "\\pageref", "LastPage"].iter().any(|s| source.contains(s))
            && !log.contains("(rerun not needed)")
}

/// The end of a log, which is where the error is, at most MAX_LOG bytes.
fn log_tail(log: &str) -> String {
    if log.len() <= MAX_LOG {
        return log.to_string();
    }
    let mut start = log.len() - MAX_LOG;
    while !log.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &log[start..])
}

// ---- Running TeX ------------------------------------------------------------

/// TeX's own trees in the home folder, which it must still read: packages
/// installed for this user (TEXMFHOME), font maps (TEXMFVAR), settings.
#[derive(Clone, Debug, Default)]
struct TexHome {
    vars: Vec<(&'static str, PathBuf)>,
}

/// Asked of kpsewhich once per TeX install, with the real environment.
fn tex_home(engine: &Engine) -> TexHome {
    static SEEN: OnceLock<Mutex<HashMap<PathBuf, TexHome>>> = OnceLock::new();
    let dir = engine.path.parent().map(Path::to_path_buf).unwrap_or_default();
    let seen = SEEN.get_or_init(Default::default);
    if let Some(t) = seen.lock().ok().and_then(|m| m.get(&dir).cloned()) {
        return t;
    }
    let mut t = TexHome::default();
    if engine.kind != Kind::Tectonic {
        for var in ["TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG"] {
            let out = Command::new(dir.join("kpsewhich")).arg(format!("-var-value={var}")).stdin(Stdio::null()).stderr(Stdio::null()).output();
            if let Ok(o) = out {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                // A plain absolute path only: anything else (a list, a variable) is left to TeX's default.
                if v.starts_with('/') && !v.contains([';', ':', '{', '$', '"', '\\']) {
                    t.vars.push((var, PathBuf::from(v)));
                }
            }
        }
    }
    if let Ok(mut m) = seen.lock() {
        m.insert(dir, t.clone());
    }
    t
}

/// A path as an SBPL string, or None when it can't be one safely.
#[cfg(target_os = "macos")]
fn sb_str(p: &Path) -> Option<String> {
    let s = p.to_str()?;
    (!s.contains(['"', '\\', '\n'])).then(|| format!("\"{s}\""))
}

/// The sandbox profile for one compile in `work`.
#[cfg(target_os = "macos")]
fn sandbox_profile(work: &Path, engine: &Engine, home: &TexHome) -> Option<String> {
    let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let engine_dir = real(&engine.path).parent()?.to_path_buf();
    let mut read_ok = vec![sb_str(work)?, sb_str(&engine_dir)?];
    for (_, p) in &home.vars {
        if let Some(s) = sb_str(&real(p)) {
            read_ok.push(s);
        }
    }
    let user_home = crate::vault::home_dir();
    if let Some(h) = &user_home {
        if let Some(s) = sb_str(&h.join("Library/Fonts")) {
            read_ok.push(s);
        }
        if engine.kind == Kind::Tectonic
            && let Some(s) = sb_str(&h.join("Library/Caches/Tectonic"))
        {
            read_ok.push(s);
        }
    }
    let subpaths = |v: &[String]| v.iter().map(|s| format!("(subpath {s})")).collect::<Vec<_>>().join(" ");
    let mut exec_ok = vec![sb_str(&engine_dir)?, "\"/usr/local/texlive\"".into(), "\"/Library/TeX\"".into()];
    if engine.path.starts_with("/opt/homebrew") || engine_dir.starts_with("/opt/homebrew") {
        exec_ok.push("\"/opt/homebrew\"".into());
    }
    let mut write_ok = vec![sb_str(work)?];
    if engine.kind == Kind::Tectonic
        && let Some(s) = user_home.as_ref().and_then(|h| sb_str(&h.join("Library/Caches/Tectonic")))
    {
        write_ok.push(s);
    }
    Some(format!(
        "(version 1)\n(allow default)\n(deny network*)\n\
(deny process-exec*)\n(allow process-exec* {exec} (literal \"/bin/sh\") (literal \"/bin/bash\") (literal \"/bin/dash\") (literal \"/bin/zsh\"))\n\
(deny file-write*)\n(allow file-write* {write} (literal \"/dev/null\") (literal \"/dev/tty\"))\n\
(deny file-read* (subpath \"/Users\") (subpath \"/Volumes\") (subpath \"/private/etc\") (subpath \"/private/tmp\") (subpath \"/private/var/folders\") (subpath \"/private/var/root\") (subpath \"/Library/Keychains\"))\n\
(allow file-read* {read})\n",
        exec = subpaths(&exec_ok),
        write = subpaths(&write_ok),
        read = subpaths(&read_ok),
    ))
}

/// A private folder for one compile, removed when dropped.
struct WorkDir(PathBuf);

impl WorkDir {
    fn new() -> std::io::Result<WorkDir> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("phaethon-latex-{}-{n}-{nanos}", std::process::id()));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut b = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&dir)?;
        Ok(WorkDir(dir.canonicalize()?))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// How one run ended.
enum Ran {
    Exited(bool),
    TimedOut,
}

/// One run of `engine` on `doc.tex` in `work`, walled, until `deadline`.
fn run_once(engine: &Engine, work: &Path, deadline: Instant) -> Result<Ran, Failure> {
    let home = tex_home(engine);
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let profile = sandbox_profile(work, engine, &home).ok_or_else(|| Failure::Setup("Phaethon couldn’t set up the walls LaTeX runs inside.".into()))?;
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.arg("-p").arg(profile).arg(&engine.path);
        c
    };
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&home, work, deadline);
        return Err(Failure::Setup(
            "Phaethon compiles LaTeX only inside a sandbox, which it has on macOS so far. The document’s source is below.".into(),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        match engine.kind {
            Kind::Tectonic => {
                cmd.args(["--untrusted", "--keep-logs", "--outdir"]).arg(work).arg("doc.tex");
            }
            _ => {
                cmd.args(["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"]);
            }
        }
        let engine_dir = engine.path.parent().map(Path::to_path_buf).unwrap_or_default();
        cmd.env_clear()
            .env("PATH", std::env::join_paths([engine_dir.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap_or_default())
            .env("HOME", work)
            .env("TMPDIR", work)
            .env("TEXMFOUTPUT", work)
            .env("TEXMFCACHE", work)
            .env("openout_any", "p")
            .env("openin_any", "p")
            .env("shell_escape", "f")
            // Long log lines, so an error's line and command aren't wrapped apart.
            .env("max_print_line", "1000")
            .env("error_line", "254")
            .env("half_error_line", "238");
        for (k, v) in &home.vars {
            cmd.env(k, v);
        }
        cmd.current_dir(work).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
            // SAFETY: setrlimit is async-signal-safe; it only lowers this child's own limits.
            unsafe {
                cmd.pre_exec(|| {
                    let fsize = libc::rlimit { rlim_cur: MAX_FILE as libc::rlim_t, rlim_max: MAX_FILE as libc::rlim_t };
                    libc::setrlimit(libc::RLIMIT_FSIZE, &fsize);
                    let cpu = libc::rlimit { rlim_cur: 2 * TIMEOUT.as_secs() as libc::rlim_t, rlim_max: 2 * TIMEOUT.as_secs() as libc::rlim_t };
                    libc::setrlimit(libc::RLIMIT_CPU, &cpu);
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn().map_err(|e| Failure::Setup(format!("LaTeX couldn’t be started: {e}")))?;
        let pid = child.id() as libc::pid_t;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(Ran::Exited(status.success())),
                Ok(None) if Instant::now() >= deadline => {
                    // SAFETY: the child leads its own group (process_group(0)); killpg only sends a signal.
                    unsafe {
                        libc::killpg(pid, libc::SIGKILL);
                    }
                    let _ = child.wait();
                    return Ok(Ran::TimedOut);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => {
                    // SAFETY: as above.
                    unsafe {
                        libc::killpg(pid, libc::SIGKILL);
                    }
                    let _ = child.wait();
                    return Err(Failure::Setup(format!("LaTeX stopped unexpectedly: {e}")));
                }
            }
        }
    }
}

/// Compile `source` (a whole document, or with `figure` a figure's body)
/// with `engine` inside the walls; the PDF's bytes.
pub fn compile(engine: &Engine, source: &str, figure: bool, timeout: Duration) -> Result<Vec<u8>, Failure> {
    if source.len() > MAX_SOURCE {
        return Err(Failure::Setup(format!("This document is longer than Phaethon compiles ({} KB at most).", MAX_SOURCE / 1024)));
    }
    let (doc, offset) = if figure && !is_document(source) { figure_document(source) } else { (source.to_string(), 0) };
    let work = WorkDir::new().map_err(|e| Failure::Setup(format!("Phaethon couldn’t make a folder to compile in: {e}")))?;
    fs::write(work.0.join("doc.tex"), doc).map_err(|e| Failure::Setup(format!("Phaethon couldn’t write the document to compile: {e}")))?;
    let deadline = Instant::now() + timeout;
    let read_log = || {
        let bytes = fs::read(work.0.join("doc.log")).unwrap_or_default();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let runs = if engine.kind == Kind::Tectonic { 1 } else { MAX_RUNS };
    for run in 1..=runs {
        match run_once(engine, &work.0, deadline)? {
            Ran::TimedOut => return Err(Failure::Timeout { log: log_tail(&read_log()) }),
            Ran::Exited(false) => {
                let log = read_log();
                let (message, line) = parse_error(&log, offset);
                return Err(Failure::Error { message, line, log: log_tail(&log) });
            }
            Ran::Exited(true) => {
                if run == runs || !needs_rerun(&read_log(), source) {
                    break;
                }
            }
        }
    }
    let pdf = work.0.join("doc.pdf");
    let size = fs::metadata(&pdf).map(|m| m.len()).map_err(|_| {
        let log = read_log();
        let (message, line) = parse_error(&log, offset);
        Failure::Error { message, line, log: log_tail(&log) }
    })?;
    if size > MAX_PDF {
        return Err(Failure::Setup(format!("The PDF is larger than Phaethon shows ({} MB at most).", MAX_PDF / 1024 / 1024)));
    }
    fs::read(&pdf).map_err(|e| Failure::Setup(format!("Phaethon couldn’t read the PDF: {e}")))
}

// ---- Cache ------------------------------------------------------------------

/// A stable 128-bit hash (two FNV-1a passes), as 32 hex digits.
fn hash_hex(parts: &[&[u8]]) -> String {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x6c62_272e_07bb_0142;
    for part in parts {
        for &byte in part.iter().chain((part.len() as u64).to_le_bytes().iter()) {
            a = (a ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3);
            b = (b ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3).rotate_left(5);
        }
    }
    format!("{a:016x}{b:016x}")
}

/// The cache id of a compile.
pub fn cache_id(kind: Kind, figure: bool, source: &str) -> String {
    hash_hex(&[kind.bin().as_bytes(), if figure { b"figure" } else { b"document" }, source.as_bytes()])
}

/// Whether `id` could be a cache id (and so is safe as a file name).
pub fn is_cache_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn cached_pdf(cache: &Path, id: &str) -> Option<PathBuf> {
    let p = cache.join(format!("{id}.pdf"));
    (is_cache_id(id) && p.is_file()).then_some(p)
}

fn cache_put(cache: &Path, id: &str, pdf: &[u8]) {
    if fs::create_dir_all(cache).is_err() {
        return;
    }
    let tmp = cache.join(format!("{id}.part"));
    if fs::write(&tmp, pdf).is_ok() {
        let _ = fs::rename(&tmp, cache.join(format!("{id}.pdf")));
    }
    // Keep the newest MAX_CACHED.
    if let Ok(rd) = fs::read_dir(cache) {
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "pdf"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        if files.len() > MAX_CACHED {
            files.sort();
            for (_, p) in &files[..files.len() - MAX_CACHED] {
                let _ = fs::remove_file(p);
            }
        }
    }
}

// ---- What the webview gets --------------------------------------------------

/// How a compile came out, for the webview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    /// The PDF is ready: `latex_pdf` with `id` returns it.
    #[serde(rename_all = "camelCase")]
    Ok { id: String, engine: String },
    /// The document has an error (or ran too long).
    #[serde(rename_all = "camelCase")]
    Failed { message: String, line: Option<u32>, log: String },
    /// No TeX on this computer.
    NoEngine { message: String },
    /// Phaethon can't compile here (no sandbox, too long, a folder problem).
    Unavailable { message: String },
}

/// Compiles still failing from this session, so a message shown again doesn't recompile them.
fn failures() -> &'static Mutex<HashMap<String, Outcome>> {
    static F: OnceLock<Mutex<HashMap<String, Outcome>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

/// Compile with the cache: the same source, kind and engine never compile twice.
pub fn compile_cached(cache: &Path, engines: &[Engine], source: &str, figure: bool, timeout: Duration) -> Outcome {
    let Some(engine) = choose(engines, source) else {
        return Outcome::NoEngine { message: format!("There’s no LaTeX on this computer. {INSTALL_HINT}") };
    };
    let id = cache_id(engine.kind, figure, source);
    let ok = || Outcome::Ok { id: id.clone(), engine: engine.kind.name().into() };
    if cached_pdf(cache, &id).is_some() {
        return ok();
    }
    if let Some(f) = failures().lock().ok().and_then(|m| m.get(&id).cloned()) {
        return f;
    }
    // One compile at a time: a conversation with many figures doesn't start many TeX runs at once.
    static ONE: Mutex<()> = Mutex::new(());
    let _turn = ONE.lock().unwrap_or_else(|e| e.into_inner());
    if cached_pdf(cache, &id).is_some() {
        return ok();
    }
    let outcome = match compile(&engine, source, figure, timeout) {
        Ok(pdf) => {
            cache_put(cache, &id, &pdf);
            if cached_pdf(cache, &id).is_none() {
                return Outcome::Unavailable { message: "Phaethon couldn’t keep the PDF it made.".into() };
            }
            return ok();
        }
        Err(Failure::Error { message, line, log }) => Outcome::Failed { message, line, log },
        Err(Failure::Timeout { log }) => Outcome::Failed {
            message: format!("LaTeX took longer than {} seconds, so Phaethon stopped it. The document may loop for ever.", timeout.as_secs()),
            line: None,
            log,
        },
        Err(Failure::Setup(message)) => return Outcome::Unavailable { message },
    };
    if let Ok(mut m) = failures().lock() {
        if m.len() > 200 {
            m.clear();
        }
        m.insert(id, outcome.clone());
    }
    outcome
}

/// A file name from a title: lowercase letters, digits and dashes, at most 60.
pub fn slug(title: &str, fallback: &str) -> String {
    let mut s = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
        if s.len() >= 60 {
            break;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { fallback.to_string() } else { s }
}

/// What Save to space wrote, as paths in the space.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub tex: String,
    pub pdf: Option<String>,
    /// Why there's no PDF beside the source, in plain words.
    pub note: Option<String>,
}

/// Write `source` and, when it compiles, its PDF into `documents/` in the
/// space as `<slug>.tex` and `<slug>.pdf`, choosing `<slug>-2` and on when
/// either name is taken: nothing is ever overwritten.
pub fn save(space: &Path, source: &str, pdf: Option<&[u8]>, title: &str, figure: bool) -> Result<Saved, String> {
    if source.len() > MAX_SOURCE {
        return Err("This document is too long to save from here.".into());
    }
    let base = slug(title, if figure { "figure" } else { "document" });
    for n in 1..=999 {
        let name = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let tex_rel = format!("documents/{name}.tex");
        let pdf_rel = format!("documents/{name}.pdf");
        let tex = tools::resolve(space, &tex_rel, false).map_err(|_| "The space’s documents folder can’t be used: it leads outside the space.".to_string())?;
        let pdf_path = tools::resolve(space, &pdf_rel, false).map_err(|_| "The space’s documents folder can’t be used: it leads outside the space.".to_string())?;
        if tex.symlink_metadata().is_ok() || pdf_path.symlink_metadata().is_ok() {
            continue;
        }
        if let Some(dir) = tex.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("The documents folder couldn’t be made: {e}"))?;
        }
        // create_new: if the name was taken a moment ago, try the next one.
        let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(&tex) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{tex_rel} couldn’t be written: {e}")),
        };
        f.write_all(source.as_bytes()).map_err(|e| format!("{tex_rel} couldn’t be written: {e}"))?;
        let Some(pdf) = pdf else {
            return Ok(Saved { tex: tex_rel, pdf: None, note: None });
        };
        let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(&pdf_path) {
            Ok(f) => f,
            Err(e) => return Ok(Saved { tex: tex_rel, pdf: None, note: Some(format!("The PDF couldn’t be saved beside it: {e}")) }),
        };
        f.write_all(pdf).map_err(|e| format!("{pdf_rel} couldn’t be written: {e}"))?;
        return Ok(Saved { tex: tex_rel, pdf: Some(pdf_rel), note: None });
    }
    Err("There are too many documents with this name in the space already.".into())
}

// ---- Commands ---------------------------------------------------------------

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_cache_dir().map(|d| d.join("latex")).map_err(|e| format!("Phaethon has no cache folder: {e}"))
}

/// Which engine would compile a document here, or how to install one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub engine: Option<String>,
    pub engines: Vec<String>,
    pub message: Option<String>,
}

#[tauri::command]
pub(crate) async fn latex_status() -> Result<Status, String> {
    crate::off_main(|| {
        let found = engines();
        Ok(Status {
            engine: choose(&found, "").map(|e| e.kind.name().to_string()),
            engines: found.iter().map(|e| e.kind.name().to_string()).collect(),
            message: found.is_empty().then(|| format!("There’s no LaTeX on this computer. {INSTALL_HINT}")),
        })
    })
    .await
}

/// Compile a document (or, with `figure`, a ```tikz figure's body).
#[tauri::command]
pub(crate) async fn latex_compile(app: tauri::AppHandle, source: String, figure: Option<bool>) -> Result<Outcome, String> {
    let cache = cache_dir(&app)?;
    crate::off_main(move || Ok(compile_cached(&cache, &engines(), &source, figure.unwrap_or(false), TIMEOUT))).await
}

/// A compiled PDF's bytes, by the id `latex_compile` gave.
#[tauri::command]
pub(crate) async fn latex_pdf(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let cache = cache_dir(&app)?;
    crate::off_main(move || {
        let p = cached_pdf(&cache, &id).ok_or("That PDF isn’t here any more. Compile the document again.")?;
        fs::read(p).map(tauri::ipc::Response::new).map_err(|e| format!("The PDF couldn’t be read: {e}"))
    })
    .await
}

/// Save a document (its source, and its PDF when it compiles) into the
/// space's `documents/` folder. Returns what was written.
#[tauri::command]
pub(crate) async fn latex_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    space: String,
    source: String,
    title: String,
    figure: Option<bool>,
) -> Result<Saved, String> {
    let dir = state.vault.space_dir(&space)?;
    let cache = cache_dir(&app)?;
    crate::off_main(move || {
        let figure = figure.unwrap_or(false);
        let (pdf, note) = match compile_cached(&cache, &engines(), &source, figure, TIMEOUT) {
            Outcome::Ok { id, .. } => (cached_pdf(&cache, &id).and_then(|p| fs::read(p).ok()), None),
            Outcome::Failed { message, .. } | Outcome::NoEngine { message } | Outcome::Unavailable { message } => (None, Some(message)),
        };
        // A figure is saved as a document that compiles on its own.
        let text = if figure && !is_document(&source) { figure_document(&source).0 } else { source };
        let mut saved = save(&dir, &text, pdf.as_deref(), &title, figure)?;
        if saved.pdf.is_none() && saved.note.is_none() {
            saved.note = note.map(|m| format!("Only the source was saved: {m}"));
        }
        Ok(saved)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("phaethon-latex-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn chooses_pdflatex_unless_the_document_needs_another() {
        let all: Vec<Engine> = Kind::ALL.iter().map(|&kind| Engine { kind, path: PathBuf::from(kind.bin()) }).collect();
        assert_eq!(choose(&all, "\\documentclass{article}").unwrap().kind, Kind::Pdflatex);
        assert_eq!(choose(&all, "\\usepackage{fontspec}").unwrap().kind, Kind::Xelatex);
        assert_eq!(choose(&all, "\\usepackage{unicode-math}").unwrap().kind, Kind::Xelatex);
        assert_eq!(choose(&all, "\\directlua{x=1}").unwrap().kind, Kind::Lualatex);
        let only_xe = vec![Engine { kind: Kind::Xelatex, path: "xelatex".into() }];
        assert_eq!(choose(&only_xe, "plain").unwrap().kind, Kind::Xelatex);
        assert!(choose(&[], "x").is_none());
    }

    #[test]
    fn errors_in_plain_words_with_their_line() {
        let log = "(./doc.tex\n! Undefined control sequence.\nl.12 Here is \\foo\n                {x}\n";
        let (m, l) = parse_error(log, 0);
        assert_eq!(l, Some(12));
        assert!(m.contains("\\foo") && m.contains("line 12"), "{m}");
        let (m, _) = parse_error("! LaTeX Error: File `standalone.cls' not found.\n\nl.1 \\documentclass", 0);
        assert!(m.contains("“standalone” isn’t installed") && m.contains("tlmgr install standalone"), "{m}");
        let (m, l) = parse_error("! Missing $ inserted.\n<inserted text>\nl.20 x^2", 7);
        assert!(m.contains("outside $…$ near line 13"), "{m}");
        assert_eq!(l, Some(13));
        let (m, _) = parse_error("! I can't write on file `../x.txt'.\n", 0);
        assert!(m.contains("outside its own folder"), "{m}");
        let (m, l) = parse_error("no error here", 0);
        assert!(m.contains("couldn’t make a PDF") && l.is_none());
        let (m, _) = parse_error("! Package pgfplots Error: Sorry, x.\nl.4 x", 0);
        assert_eq!(m, "LaTeX stopped near line 4: Package pgfplots Error: Sorry, x.");
    }

    #[test]
    fn figures_wrap_into_a_cropped_page_with_their_lines_moved_up() {
        let (doc, before) = figure_document("\\usetikzlibrary{matrix}\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}");
        assert!(doc.starts_with("\\documentclass{article}"));
        let lines: Vec<&str> = doc.lines().collect();
        assert!(lines[..before as usize].contains(&"\\usetikzlibrary{matrix}"), "library moved into the preamble");
        assert_eq!(lines[before as usize], "", "its line stays, blank");
        assert!(lines[before as usize + 1].starts_with("\\begin{tikzpicture}"));
        assert!(!doc.contains("pgfplots"), "pgfplots only when the figure plots");
        let (doc, _) = figure_document("\\draw (0,0) circle (1);");
        assert!(doc.contains("\\begin{tikzpicture}\n\\draw (0,0) circle (1);\n\\end{tikzpicture}"));
        let (doc, _) = figure_document("\\begin{tikzpicture}\\begin{axis}\\addplot{x};\\end{axis}\\end{tikzpicture}");
        assert!(doc.contains("\\usepackage{pgfplots}"));
    }

    #[test]
    fn cache_ids_are_stable_hex_and_differ_by_engine_kind_and_source() {
        let a = cache_id(Kind::Pdflatex, false, "x");
        assert!(is_cache_id(&a), "{a}");
        assert_eq!(a, cache_id(Kind::Pdflatex, false, "x"));
        assert_ne!(a, cache_id(Kind::Xelatex, false, "x"));
        assert_ne!(a, cache_id(Kind::Pdflatex, true, "x"));
        assert_ne!(a, cache_id(Kind::Pdflatex, false, "y"));
        for bad in ["", "../etc/passwd", "ABCDEF0123456789abcdef0123456789", "g0000000000000000000000000000000"] {
            assert!(!is_cache_id(bad), "{bad}");
        }
        let dir = tmp("cache");
        assert!(cached_pdf(&dir, "../x").is_none());
        cache_put(&dir, &a, b"%PDF-1.5");
        assert_eq!(fs::read(cached_pdf(&dir, &a).unwrap()).unwrap(), b"%PDF-1.5");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn slugs_are_plain_file_names() {
        assert_eq!(slug("M301 Study Guide: Vectors & Matrices!", "document"), "m301-study-guide-vectors-matrices");
        assert_eq!(slug("../../etc", "document"), "etc");
        assert_eq!(slug("…", "figure"), "figure");
        assert!(slug(&"a".repeat(200), "d").len() <= 60);
    }

    #[test]
    fn save_never_overwrites_and_stays_in_the_space() {
        let space = tmp("save");
        let a = save(&space, "\\documentclass{article}", Some(b"%PDF"), "Study guide", false).unwrap();
        assert_eq!(a, Saved { tex: "documents/study-guide.tex".into(), pdf: Some("documents/study-guide.pdf".into()), note: None });
        let b = save(&space, "second", Some(b"%PDF2"), "Study guide", false).unwrap();
        assert_eq!(b.tex, "documents/study-guide-2.tex");
        assert_eq!(fs::read_to_string(space.join("documents/study-guide.tex")).unwrap(), "\\documentclass{article}");
        // A PDF alone with the name takes it too.
        fs::write(space.join("documents/notes.pdf"), "x").unwrap();
        assert_eq!(save(&space, "s", None, "notes", false).unwrap().tex, "documents/notes-2.tex");
        assert_eq!(fs::read_to_string(space.join("documents/notes.pdf")).unwrap(), "x");
        #[cfg(unix)]
        {
            let other = tmp("save-out");
            let space2 = tmp("save2");
            std::os::unix::fs::symlink(&other, space2.join("documents")).unwrap();
            assert!(save(&space2, "s", None, "x", false).is_err(), "a documents folder leading out is refused");
            assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
            fs::remove_dir_all(&other).unwrap();
            fs::remove_dir_all(&space2).unwrap();
        }
        fs::remove_dir_all(&space).unwrap();
    }

    /// A fake engine: a shell script standing in for pdflatex.
    #[cfg(target_os = "macos")]
    fn fake(dir: &Path, script: &str) -> Engine {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("pdflatex");
        fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        Engine { kind: Kind::Pdflatex, path: p }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_fake_engine_that_hangs_is_killed_at_the_deadline() {
        let dir = tmp("fake-hang");
        // Only shell builtins: the sandbox lets TeX run nothing but its own programs and the shell.
        let e = fake(&dir, "while :; do :; done");
        let t = Instant::now();
        let r = compile(&e, "\\documentclass{article}", false, Duration::from_secs(2));
        assert!(matches!(r, Err(Failure::Timeout { .. })), "{r:?}");
        assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_fake_engine_error_comes_back_in_plain_words() {
        let dir = tmp("fake-err");
        let e = fake(&dir, "printf '! Undefined control sequence.\\nl.3 \\\\foo\\n' > doc.log; exit 1");
        match compile(&e, "\\documentclass{article}", false, Duration::from_secs(20)) {
            Err(Failure::Error { message, line, log }) => {
                assert!(message.contains("\\foo"), "{message}");
                assert_eq!(line, Some(3));
                assert!(log.contains("Undefined control sequence"));
            }
            other => panic!("{other:?}"),
        }
        // No engine at all: the install hint, and nothing runs.
        let out = compile_cached(&dir.join("cache"), &[], "\\documentclass{article}", false, TIMEOUT);
        assert!(matches!(&out, Outcome::NoEngine { message } if message.contains("MacTeX") && message.contains("TeX Live") && message.contains("tectonic")), "{out:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_fake_engine_runs_in_its_own_empty_folder_and_environment() {
        let dir = tmp("fake-env");
        let e = fake(&dir, "export -p > doc.log; pwd >> doc.log; for f in * .*; do echo \"$f\"; done >> doc.log; exit 1");
        let Err(Failure::Error { log, .. }) = compile(&e, "\\documentclass{article}", false, Duration::from_secs(20)) else { panic!() };
        assert!(log.contains("openout_any=\"p\"") && log.contains("shell_escape=\"f\""), "{log}");
        assert!(!log.contains("CARGO") && !log.contains("USER="), "the environment is cleared: {log}");
        assert!(log.contains("phaethon-latex-"), "{log}");
        assert!(log.lines().any(|l| l == "doc.tex") && !log.lines().any(|l| l.ends_with(".pdf")), "only the document in its folder: {log}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
