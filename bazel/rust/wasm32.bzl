"""Wasm32 Rust toolchains with the Cargo release profile and crate-specific flags."""

load("@rules_rust//rust:toolchain.bzl", "rust_toolchain")

# Each execution platform gets its own binaries, including when execution is remote.
HOSTS = {
    "linux_aarch64": ("aarch64-unknown-linux-gnu", ["@platforms//cpu:aarch64", "@platforms//os:linux"]),
    "linux_x86_64": ("x86_64-unknown-linux-gnu", ["@platforms//cpu:x86_64", "@platforms//os:linux"]),
    "macos_aarch64": ("aarch64-apple-darwin", ["@platforms//cpu:aarch64", "@platforms//os:macos"]),
}

def wasm32_rust(name, constraint, rust_std, rustflags, codegen_units = 1):
    native.platform(
        name = name,
        constraint_values = [
            "@platforms//cpu:wasm32",
            "@platforms//os:none",
            constraint,
        ],
        visibility = ["//visibility:public"],
    )
    for host, (exec_triple, exec_constraints) in HOSTS.items():
        tools = "@rust_exec_%s//:" % host
        rust_toolchain(
            name = "%s_%s_impl" % (name, host),
            binary_ext = ".wasm",
            cargo = tools + "cargo",
            channel = "nightly",
            debug_info = {"dbg": "0", "fastbuild": "0", "opt": "0"},
            default_edition = "2021",
            dylib_ext = ".wasm",
            exec_triple = exec_triple,
            # Staged wasm can be a tool dependency; its panic and target flags must not change.
            extra_exec_rustc_flags = rustflags + ["-Ccodegen-units=%d" % codegen_units],
            extra_rustc_flags = rustflags + ["-Ccodegen-units=%d" % codegen_units],
            iso_date = "2026-05-14",
            linker = tools + "rust-lld",
            linker_type = "direct",
            lto = ":lto_manual",
            opt_level = {"dbg": "3", "fastbuild": "3", "opt": "3"},
            rust_doc = tools + "rustdoc",
            rust_std = rust_std,
            rustc = tools + "rustc",
            rustc_lib = tools + "rustc_lib",
            staticlib_ext = ".a",
            stdlib_linkflags = [],
            strip_level = {"dbg": "debuginfo", "fastbuild": "debuginfo", "opt": "debuginfo"},
            target_triple = "wasm32-unknown-unknown",
            version = "nightly",
        )
        native.toolchain(
            name = "%s_%s_toolchain" % (name, host),
            exec_compatible_with = exec_constraints + ["//bazel/rust:rust_pool"],
            target_compatible_with = [
                "@platforms//cpu:wasm32",
                "@platforms//os:none",
                constraint,
            ],
            toolchain = "%s_%s_impl" % (name, host),
            toolchain_type = "@rules_rust//rust:toolchain_type",
        )
