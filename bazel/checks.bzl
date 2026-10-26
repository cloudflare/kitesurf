"""Shared Bazel test helpers for package checks."""

load("@aspect_rules_js//js:defs.bzl", "js_library", "js_test")

HOISTED = [
    "//:node_modules/devtools-protocol",
    "//:node_modules/undici",
    "//:node_modules/zod",
]

def tsc_test(
        name,
        bin,
        project = "tsconfig.json",
        data = [],
        project_in_data = False,
        size = "small",
        **kwargs):
    """Run the package script's TypeScript compiler without emitting files."""
    bin.tsc_test(
        name = name,
        args = ["--noEmit", "-p", project],
        chdir = native.package_name(),
        data = data + HOISTED + ([] if project_in_data or project in data else [project]),
        include_transitive_types = True,
        include_types = True,
        size = size,
        **kwargs
    )

def node_test(name, args, data, size = "small", **kwargs):
    """Run a node --test suite with spec and JUnit output."""
    js_test(
        name = name,
        args = args,
        chdir = native.package_name(),
        data = data,
        entry_point = "//scripts:node_test_bazel",
        size = size,
        **kwargs
    )

def strict_ratchet_test(
        name,
        data,
        project = "tsconfig.strict.json",
        baseline = None,
        only = None,
        size = "small",
        **kwargs):
    """Fail when strict TypeScript errors exceed the checked-in per-file baseline."""
    args = ["--project", project]
    files = [project]
    if baseline:
        args += ["--baseline", baseline]
        files.append(baseline)
    if only:
        args += ["--only", only]
    js_test(
        name = name,
        args = args,
        chdir = native.package_name(),
        data = data + HOISTED + files,
        entry_point = "//scripts:ts_strict_ratchet",
        include_transitive_types = True,
        include_types = True,
        size = size,
        **kwargs
    )

def workspace_configs():
    """Export this package's package.json and tsconfig inputs for root guards."""
    js_library(
        name = "workspace_configs",
        srcs = native.glob(
            ["**/package.json", "**/tsconfig*.json"],
            allow_empty = True,
            exclude = ["**/dist/**"],
        ),
        visibility = ["//:__pkg__"],
    )
