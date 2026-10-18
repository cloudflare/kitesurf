// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use anyhow::{Context, Result};
use instrumentor::{instrument, HookPoint, Tracee};
use walrus::ModuleConfig;

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("[memprof-rewriter {}] {}", record.level(), record.args());
    }
    fn flush(&self) {}
}

const PATTERNS: &[(&str, &str)] = &[
    ("__rust_realloc", "rust_realloc"),
    ("__rust_dealloc", "rust_dealloc"),
    ("__rust_alloc_zeroed", "rust_alloc_zeroed"),
    ("__rust_alloc", "rust_alloc"),
];

fn suffix_for(name: &str) -> Option<&'static str> {
    for (needle, suffix) in PATTERNS {
        if name.ends_with(needle) || name.contains(&format!("::{needle}")) {
            return Some(suffix);
        }
    }
    None
}

fn discover_tracees(wasm_bytes: &[u8]) -> Result<Vec<Tracee>> {
    let mut config = ModuleConfig::default();
    config.generate_name_section(true);
    let m = walrus::Module::from_buffer_with_config(wasm_bytes, &config)
        .with_context(|| "parse wasm for name discovery")?;

    let mut found: Vec<(String, &'static str)> = Vec::new();
    for func in m.functions() {
        let Some(name) = func.name.as_ref() else {
            continue;
        };
        if let Some(suffix) = suffix_for(name) {
            if !found.iter().any(|(_, s)| *s == suffix) {
                found.push((name.clone(), suffix));
            }
        }
    }

    if found.is_empty() {
        anyhow::bail!(
            "no Rust allocator symbols found in wasm name section. \
             Did you build with a profile that has `strip = \"none\"`?"
        );
    }

    log::info!("Discovered {} allocator symbols to hook:", found.len());
    for (name, suffix) in &found {
        log::info!("  {name}  ->  wmprof.posthook_{suffix}");
    }

    Ok(found
        .into_iter()
        .map(|(name, _)| Tracee {
            name,
            hook_points: [HookPoint::Post].into_iter().collect(),
        })
        .collect())
}

fn main() -> Result<()> {
    log::set_max_level(log::LevelFilter::Info);
    let _ = log::set_logger(&StderrLogger);

    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: {} <input.wasm> <output.wasm>", args[0]);
        std::process::exit(1);
    }
    let input_path = &args[1];
    let output_path = &args[2];

    let input = std::fs::read(input_path).with_context(|| format!("read {input_path}"))?;
    let original_size = input.len();

    log::info!("Scanning {input_path} ({original_size} bytes)");
    let tracees = discover_tracees(&input)?;

    log::info!("Instrumenting...");
    let output = instrument(input, &tracees).with_context(|| "instrument failed")?;

    std::fs::write(output_path, &output).with_context(|| format!("write {output_path}"))?;
    log::info!(
        "Wrote {output_path} ({} bytes, {:+.1}% vs input)",
        output.len(),
        100.0 * (output.len() as f64 - original_size as f64) / original_size as f64
    );

    let manifest_path = format!("{output_path}.memprof.json");
    let manifest_entries: Vec<String> = tracees
        .iter()
        .map(|t| {
            let suffix = suffix_for(&t.name).unwrap_or("unknown");
            format!(
                "    {{\"wasm_name\": {:?}, \"hook_suffix\": {:?}}}",
                t.name, suffix
            )
        })
        .collect();
    let manifest = format!(
        "{{\n  \"tracees\": [\n{}\n  ]\n}}\n",
        manifest_entries.join(",\n")
    );
    std::fs::write(&manifest_path, manifest).with_context(|| format!("write {manifest_path}"))?;
    log::info!("Wrote manifest {manifest_path}");

    Ok(())
}
