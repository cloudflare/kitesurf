"""Build wasm32 std with the same pinned nightly and flags as the core crate."""

load("@wasm32_unwind_std//:flags.bzl", "BUILD_STD", "RUSTFLAGS")

STD_CRATES = [
    "addr2line",
    "adler2",
    "alloc",
    "cfg_if",
    "compiler_builtins",
    "core",
    "dlmalloc",
    "gimli",
    "hashbrown",
    "libc",
    "memchr",
    "miniz_oxide",
    "object",
    "panic_abort",
    "panic_unwind",
    "proc_macro",
    "rustc_demangle",
    "rustc_literal_escaper",
    "rustc_std_workspace_alloc",
    "rustc_std_workspace_core",
    "std",
    "std_detect",
    "unwind",
]

_SCRIPT = """\
set -euo pipefail
ROOT="$PWD"
SRC="$PWD/$1"
OUT="$PWD/$2"
RUSTC="$PWD/$3"
CARGO="$PWD/$4"
CRATES="$5"
PROFILE="$6"
RUSTFLAGS_TOML="$7"
B=/tmp/kitesurf-wasm-std
exec 9>"$B.lock"
flock 9
rm -rf "$B"
mkdir -p "$B/src" "$B/.cargo-home"
tar -xf "$SRC" -C "$B"
: > "$B/src/lib.rs"
printf '%s\\n' "$PROFILE" > "$B/Cargo.toml"
COMMIT="$("$RUSTC" -vV | sed -n 's/^commit-hash: //p')"
cat > "$B/.cargo-home/config.toml" <<EOF
[source.crates-io]
replace-with = "vendored"
[source.vendored]
directory = "$B/vendor"
[target.wasm32-unknown-unknown]
rustflags = $RUSTFLAGS_TOML
EOF
WRAPPER='#!/bin/sh\\nexec "$@" --remap-path-prefix=%s=/rustc/%s '
WRAPPER="${WRAPPER}--remap-path-prefix=%s/vendor=/rust/deps\\n"
printf "$WRAPPER" "$B" "$COMMIT" "$B" > "$B/wrap.sh"
chmod +x "$B/wrap.sh"
cd "$B"
env -i PATH=/usr/bin:/bin HOME="$B" CARGO_HOME="$B/.cargo-home" CARGO_TARGET_DIR="$B/target" \\
  RUSTC="$RUSTC" RUSTC_WRAPPER="$B/wrap.sh" __CARGO_TESTS_ONLY_SRC_ROOT="$B/library" \\
  "$CARGO" build --release --offline --target wasm32-unknown-unknown -Zbuild-std="$BUILD_STD" \\
  > "$B/cargo.log" 2>&1 || { cat "$B/cargo.log"; exit 1; }
DEPS="$B/target/wasm32-unknown-unknown/release/deps"
GOT="$(
  cd "$DEPS"
  ls lib*.rlib |
    grep -v '^libstd_stub' |
    sed 's/^lib//; s/-[0-9a-f]*\\.rlib$//' |
    sort |
    tr '\\n' ' '
)"
[ "$GOT" = "$CRATES " ] || { echo "build-std produced [$GOT], expected [$CRATES ]"; exit 1; }
for crate in $CRATES; do cp "$DEPS"/lib"$crate"-*.rlib "$OUT/lib$crate.rlib"; done
cd "$ROOT"
rm -rf "$B"
"""

_PROFILE = """\
[package]
name = "std_stub"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[profile.release]
opt-level = 3
lto = true
codegen-units = 1

[workspace]
"""

def _wasm_std_impl(ctx):
    outputs = [
        ctx.actions.declare_file("lib/rustlib/wasm32-unknown-unknown/lib/lib%s.rlib" % crate)
        for crate in STD_CRATES
    ]
    rustc = ctx.file._rustc
    cargo = ctx.file._cargo
    args = ctx.actions.args()
    args.add_all([ctx.file.src.path, outputs[0].dirname, rustc.path, cargo.path])
    args.add(" ".join(sorted(STD_CRATES)))
    args.add(_PROFILE)
    args.add("[%s]" % ", ".join([json.encode(flag) for flag in RUSTFLAGS]))
    ctx.actions.run_shell(
        command = _SCRIPT.replace("$BUILD_STD", ",".join(BUILD_STD)),
        arguments = [args],
        inputs = depset([ctx.file.src, rustc, cargo], transitive = [
            ctx.attr._rustc_lib.files,
            ctx.attr._host_std.files,
            ctx.attr._linker.files,
            ctx.attr._linker.default_runfiles.files,
        ]),
        outputs = outputs,
        mnemonic = "RustBuildStd",
        progress_message = "cargo -Zbuild-std for wasm32 (%s)" % ",".join(BUILD_STD),
        env = {"PATH": "/usr/bin:/bin"},
    )
    return [DefaultInfo(files = depset(outputs))]

wasm_std = rule(
    implementation = _wasm_std_impl,
    attrs = {
        "src": attr.label(mandatory = True, allow_single_file = [".tar"]),
        "_cargo": attr.label(
            default = "@rust_tools//:cargo",
            cfg = "exec",
            allow_single_file = True,
        ),
        "_host_std": attr.label(
            default = "@rust_tools//:rust_std-x86_64-unknown-linux-gnu",
            cfg = "exec",
        ),
        "_linker": attr.label(default = "@rust_tools//:rust-lld", cfg = "exec"),
        "_rustc": attr.label(
            default = "@rust_tools//:rustc",
            cfg = "exec",
            allow_single_file = True,
        ),
        "_rustc_lib": attr.label(default = "@rust_tools//:rustc_lib", cfg = "exec"),
    },
)
