"""The Rust lint gates as Bazel tests, run in CI via the `rust_lint` test suite.

Clippy warns only through `-Dwarnings` by default; the config files cargo reads are
selected via --@rules_rust//rust/settings:{clippy,rustfmt}.toml in .bazelrc.
"""

load("@aspect_rules_js//js:defs.bzl", "js_test")
load("@rules_rust//rust:defs.bzl", "rust_clippy_test", "rustfmt_test")
load("@rules_shell//shell:sh_test.bzl", "sh_test")

# Label() anchors these in this file's repository: callers may live in a dependent module.
_CHECKER = Label("//scripts/lint/rust-check:rust-check")
_RUNNER = Label("//scripts/lint/rust-check:nesting-test.sh")
_COMMENTS = Label("//scripts:rust_comments_check")
_COMMENTS_ENTRY = Label("//scripts:rust_comments_check_entry")

def rust_nesting_test(name, srcs, size = "small", **kwargs):
    """Check that every source file keeps control flow within the shared depth cap."""
    sh_test(
        name = name,
        srcs = [_RUNNER],
        args = [
            "$(rootpath %s)" % _CHECKER,
            "4",
        ] + ["$(rootpath %s)" % src for src in srcs],
        data = [_CHECKER] + srcs,
        size = size,
        **kwargs
    )

def rust_comments_test(name, srcs, size = "small", **kwargs):
    """Check the package's sources against the shared Rust comment policy."""
    js_test(
        name = name,
        args = ["$(rootpath %s)" % src for src in srcs],
        data = [_COMMENTS] + srcs,
        entry_point = _COMMENTS_ENTRY,
        size = size,
        **kwargs
    )

def rust_lint_tests(targets, **kwargs):
    """Check the package's Rust targets with clippy and rustfmt --check."""
    rust_clippy_test(
        name = "clippy_test",
        targets = targets,
        size = "large",
        **kwargs
    )
    rustfmt_test(
        name = "fmt_test",
        targets = targets,
        **kwargs
    )
