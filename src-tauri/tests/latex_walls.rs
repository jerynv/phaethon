//! The walls around compiling AI-written LaTeX (src/latex.rs), proven with the
//! real TeX on this computer: each attack is a document that would leak or
//! change something if a wall were missing. Every installed engine of
//! pdfLaTeX, XeLaTeX and LuaLaTeX is tried. Without TeX (or off macOS, where
//! nothing is compiled) the tests say so and pass.
//!
//! Each probe ends in an undefined command on purpose: the compile then fails
//! and hands back its log, where `\typeout` said what TeX could see.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use phaethon_lib::latex::{self, Engine, Failure, Kind};

fn tex_engines() -> Vec<Engine> {
    if !cfg!(target_os = "macos") {
        eprintln!("skipped: LaTeX is compiled only on macOS for now");
        return vec![];
    }
    let found: Vec<Engine> = latex::engines().into_iter().filter(|e| e.kind != Kind::Tectonic).collect();
    if found.is_empty() {
        eprintln!("skipped: no TeX installed");
    }
    found
}

/// A scratch folder outside the compile folder, as the attacks' target.
fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("phaethon-latex-walls-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn doc(body: &str) -> String {
    format!("\\documentclass{{article}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
}

/// Compile `body`, which must fail; its log.
fn log_of(e: &Engine, body: &str) -> String {
    match latex::compile(e, &doc(body), false, Duration::from_secs(60)) {
        Err(Failure::Error { log, .. }) => log,
        other => panic!("{:?}: expected a failed compile for {body:?}, got {:?}", e.kind, other.map(|b| b.len())),
    }
}

/// What TeX can see of `path`: whether it exists, and its first line when read.
fn probe(e: &Engine, path: &str) -> String {
    log_of(
        e,
        &format!(
            "\\IfFileExists{{{path}}}{{\\typeout{{PROBE-EXISTS}}}}{{\\typeout{{PROBE-MISSING}}}}\n\
\\newread\\r\\openin\\r={path}\\relax\\ifeof\\r\\typeout{{PROBE-NOREAD}}\\else\\read\\r to\\x\\typeout{{PROBE-READ:\\detokenize\\expandafter{{\\x}}}}\\fi\n\
\\phaethonundefinedcommand"
        ),
    )
}

fn assert_unreadable(e: &Engine, path: &str, secret: &str) {
    let log = probe(e, path);
    assert!(log.contains("PROBE-MISSING") && log.contains("PROBE-NOREAD"), "{:?} saw {path}:\n{log}", e.kind);
    assert!(!log.contains(secret), "{:?} leaked {path}", e.kind);
}

#[test]
fn absolute_paths_outside_tex_cannot_be_read() {
    for e in tex_engines() {
        // /etc/passwd's first line on macOS is a comment of #s.
        assert_unreadable(&e, "/etc/passwd", "PROBE-READ");
        assert_unreadable(&e, "/etc/hosts", "PROBE-READ");
        // \input too, not only \openin.
        let r = latex::compile(&e, &doc("\\input{/etc/passwd}"), false, Duration::from_secs(60));
        assert!(matches!(&r, Err(Failure::Error { message, .. }) if message.contains("/etc/passwd")), "{:?}: {r:?}", e.kind);
    }
}

#[test]
fn files_beside_the_compile_folder_cannot_be_read() {
    for e in tex_engines() {
        // The compile folder is a fresh one in the temp folder; put a secret next to it.
        let secret = std::env::temp_dir().join(format!("phaethon-secret-{}.tex", std::process::id()));
        fs::write(&secret, "\\typeout{LEAKED-PARENT}").unwrap();
        let name = secret.file_stem().unwrap().to_string_lossy().into_owned();
        let log = log_of(&e, &format!("\\input{{../{name}}}"));
        assert!(!log.contains("LEAKED-PARENT"), "{:?} read ../{name}", e.kind);
        assert_unreadable(&e, &format!("../{name}.tex"), "LEAKED-PARENT");
        assert_unreadable(&e, &secret.to_string_lossy(), "LEAKED-PARENT");
        fs::remove_file(&secret).unwrap();
    }
}

#[test]
fn dotfiles_and_the_home_folder_cannot_be_read() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    let dotfile = [".zshrc", ".bash_profile", ".profile", ".gitconfig", ".zprofile"].iter().map(|f| home.join(f)).find(|p| p.is_file());
    for e in tex_engines() {
        if let Some(dot) = &dotfile {
            assert_unreadable(&e, &dot.to_string_lossy(), "PROBE-READ");
            // ~ means the compile folder's own (HOME is set to it), where there is no such file.
            // TeX's \openin of a `~/...` name "opens" even a file that doesn't exist and reads
            // empty lines, so here the check is that no line with anything in it comes back.
            let name = dot.file_name().unwrap().to_string_lossy();
            let log = probe(&e, &format!("~/{name}"));
            assert!(log.contains("PROBE-MISSING"), "{:?} saw ~/{name}:\n{log}", e.kind);
            for line in log.lines().filter_map(|l| l.strip_prefix("PROBE-READ:")) {
                assert!(line.trim().is_empty() || line.trim() == "\\par", "{:?} read ~/{name}: {line}", e.kind);
            }
        }
        // Phaethon's own vault lives in the home folder.
        let vault = home.join("Phaethon");
        if vault.is_dir() {
            assert_unreadable(&e, &vault.join("default/MANUAL.md").to_string_lossy(), "PROBE-READ");
        }
    }
}

#[test]
fn shell_escape_runs_nothing() {
    for e in tex_engines() {
        let dir = scratch(&format!("shell-{:?}", e.kind));
        let target = dir.join("pwned");
        let body = format!("\\immediate\\write18{{touch {}}}\\typeout{{after}}\\phaethonundefinedcommand", target.display());
        let _ = log_of(&e, &body);
        assert!(!target.exists(), "{:?}: \\write18 ran a program", e.kind);
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn writes_outside_the_compile_folder_fail() {
    for e in tex_engines() {
        let dir = scratch(&format!("write-{:?}", e.kind));
        let abs = dir.join("abs.txt");
        let r = latex::compile(
            &e,
            &doc(&format!("\\newwrite\\f\\immediate\\openout\\f={}\\immediate\\write\\f{{x}}\\immediate\\closeout\\f x", abs.display())),
            false,
            Duration::from_secs(60),
        );
        assert!(r.is_err(), "{:?}: writing {} was allowed", e.kind, abs.display());
        assert!(!abs.exists(), "{:?} wrote {}", e.kind, abs.display());
        let rel = std::env::temp_dir().join("phaethon-escaped.txt");
        let _ = fs::remove_file(&rel);
        let r = latex::compile(&e, &doc("\\newwrite\\f\\immediate\\openout\\f=../phaethon-escaped.txt\\immediate\\write\\f{x}\\immediate\\closeout\\f x"), false, Duration::from_secs(60));
        assert!(matches!(&r, Err(Failure::Error { message, .. }) if message.contains("outside its own folder")), "{:?}: {r:?}", e.kind);
        assert!(!rel.exists(), "{:?} wrote ../", e.kind);
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn lua_can_neither_read_nor_write_outside() {
    let Some(e) = tex_engines().into_iter().find(|e| e.kind == Kind::Lualatex) else { return };
    let dir = scratch("lua");
    let target = dir.join("lua.txt");
    let home = std::env::var("HOME").unwrap_or_default();
    let body = format!(
        "\\directlua{{local f=io.open(\"{t}\",\"w\") if f then f:write(\"x\") f:close() end \
local g=io.open(\"{home}/.zshrc\",\"r\") texio.write_nl(\"log\",\"LUA-READ:\"..tostring(g~=nil)) \
texio.write_nl(\"log\",\"LUA-EXEC:\"..tostring(os.execute(\"touch {t}.2\")))}}\\phaethonundefinedcommand",
        t = target.display()
    );
    let log = log_of(&e, &body);
    assert!(!target.exists() && !dir.join("lua.txt.2").exists(), "Lua wrote outside:\n{log}");
    assert!(!log.contains("LUA-READ:true"), "Lua read the home folder:\n{log}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_endless_loop_is_stopped_at_the_deadline() {
    for e in tex_engines() {
        let t = Instant::now();
        let r = latex::compile(&e, &doc("\\def\\x{\\x}\\x"), false, Duration::from_secs(4));
        assert!(matches!(r, Err(Failure::Timeout { .. })), "{:?}: {:?}", e.kind, r.map(|b| b.len()));
        assert!(t.elapsed() < Duration::from_secs(15), "{:?} took {:?}", e.kind, t.elapsed());
    }
}

#[test]
fn a_figure_and_a_document_compile_to_pdfs() {
    for e in tex_engines() {
        let fig = "\\begin{tikzpicture}\\begin{axis}[width=5cm]\\addplot[domain=-2:2]{x^2};\\end{axis}\\end{tikzpicture}";
        let pdf = latex::compile(&e, fig, true, Duration::from_secs(60)).unwrap_or_else(|f| panic!("{:?}: {f:?}", e.kind));
        assert!(pdf.starts_with(b"%PDF"), "{:?}", e.kind);
        let pdf = latex::compile(&e, &doc("\\tableofcontents\\section{One}$\\int_0^1 x\\,dx$"), false, Duration::from_secs(60)).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
    }
}

#[test]
fn the_cache_compiles_a_source_once() {
    let engines = tex_engines();
    if engines.is_empty() {
        return;
    }
    let cache = scratch("cache");
    let src = doc("Cached $e^{i\\pi}+1=0$");
    let t = Instant::now();
    let a = latex::compile_cached(&cache, &engines, &src, false, latex::TIMEOUT);
    let first = t.elapsed();
    let t = Instant::now();
    let b = latex::compile_cached(&cache, &engines, &src, false, latex::TIMEOUT);
    assert_eq!(a, b);
    assert!(matches!(a, latex::Outcome::Ok { .. }), "{a:?}");
    assert!(t.elapsed() < first && t.elapsed() < Duration::from_millis(200), "second {:?} vs first {first:?}", t.elapsed());
    fs::remove_dir_all(&cache).unwrap();
}

/// A realistic study guide (TikZ, pgfplots, a table of contents, matrices)
/// through the same path the chat uses. `PHAETHON_PDF_OUT=<dir>` keeps the
/// PDFs there (the guide with each engine, and a figure), to look at.
#[test]
fn a_study_guide_with_graphs_compiles() {
    let engines = tex_engines();
    if engines.is_empty() {
        return;
    }
    let src = include_str!("fixtures/m301-study-guide.tex");
    let cache = scratch("guide");
    let out = latex::compile_cached(&cache, &engines, src, false, latex::TIMEOUT);
    let latex::Outcome::Ok { id, engine } = out else { panic!("{out:?}") };
    let pdf = fs::read(latex::cached_pdf(&cache, &id).unwrap()).unwrap();
    assert!(pdf.starts_with(b"%PDF") && pdf.len() > 20_000, "{engine}: {} bytes", pdf.len());
    if let Some(dir) = std::env::var_os("PHAETHON_PDF_OUT") {
        let dir = PathBuf::from(dir);
        fs::write(dir.join("m301-study-guide.pdf"), &pdf).unwrap();
        for e in &engines {
            let b = latex::compile(e, src, false, latex::TIMEOUT).unwrap_or_else(|f| panic!("{:?}: {f:?}", e.kind));
            fs::write(dir.join(format!("m301-study-guide-{:?}.pdf", e.kind).to_lowercase()), b).unwrap();
        }
        let fig = "\\begin{tikzpicture}[>=Stealth]\n\\draw[->] (0,0) -- (2,1) node[right] {$\\mathbf{u}$};\n\\draw[->] (0,0) -- (1,2) node[above] {$\\mathbf{v}$};\n\\draw[dashed] (2,1) -- (3,3) -- (1,2);\n\\draw[->, thick] (0,0) -- (3,3) node[above right] {$\\mathbf{u}+\\mathbf{v}$};\n\\end{tikzpicture}";
        fs::write(dir.join("vector-figure.pdf"), latex::compile(&engines[0], fig, true, latex::TIMEOUT).unwrap()).unwrap();
    }
    fs::remove_dir_all(&cache).unwrap();
}

