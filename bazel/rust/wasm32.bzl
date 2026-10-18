"""Wasm32 Rust toolchains with the Cargo release profile and crate-specific flags."""

load("@rules_rust//rust:toolchain.bzl", "rust_toolchain")

def wasm32_rust(name, constraint, rust_std, rustflags):
    native.platform(
        name = name,
        constraint_values = [
            "@platforms//cpu:wasm32",
            "@platforms//os:none",
            constraint,
        ],
        visibility = ["//visibility:public"],
    )
    rust_toolchain(
        name = name + "_impl",
        binary_ext = ".wasm",
        cargo = "@rust_tools//:cargo",
        channel = "nightly",
        debug_info = {"dbg": "0", "fastbuild": "0", "opt": "0"},
        default_edition = "2021",
        dylib_ext = ".wasm",
        exec_triple = "x86_64-unknown-linux-gnu",
        extra_rustc_flags = rustflags + ["-Ccodegen-units=1"],
        iso_date = "2026-05-14",
        linker = "@rust_tools//:rust-lld",
        linker_type = "direct",
        lto = ":lto_manual",
        opt_level = {"dbg": "3", "fastbuild": "3", "opt": "3"},
        rust_doc = "@rust_tools//:rustdoc",
        rust_std = rust_std,
        rustc = "@rust_tools//:rustc",
        rustc_lib = "@rust_tools//:rustc_lib",
        staticlib_ext = ".a",
        stdlib_linkflags = [],
        strip_level = {"dbg": "debuginfo", "fastbuild": "debuginfo", "opt": "debuginfo"},
        target_triple = "wasm32-unknown-unknown",
        version = "nightly",
    )
    native.toolchain(
        name = name + "_toolchain",
        exec_compatible_with = [
            "@platforms//cpu:x86_64",
            "@platforms//os:linux",
            "//bazel/rust:rust_pool",
        ],
        target_compatible_with = [
            "@platforms//cpu:wasm32",
            "@platforms//os:none",
            constraint,
        ],
        toolchain = name + "_impl",
        toolchain_type = "@rules_rust//rust:toolchain_type",
    )
