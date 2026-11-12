//! Finds the sound files in `assets/sounds` and builds the list of sounds that ship with ClipDeck,
//! so adding, renaming or removing a file there is all it takes: no code needs editing.

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets").join("sounds");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_lowercase().ends_with(".wav"))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());

    let mut code = String::from("/// Every .wav file in `assets/sounds`, embedded in the app.\nconst SHIPPED: &[(&str, &[u8])] = &[\n");
    for name in &names {
        let path = dir.join(name).to_string_lossy().replace('\\', "/");
        println!("cargo:rerun-if-changed={path}");
        writeln!(code, "    ({name:?}, include_bytes!({path:?})),").unwrap();
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("shipped_sounds.rs");
    std::fs::write(out, code).unwrap();
}
