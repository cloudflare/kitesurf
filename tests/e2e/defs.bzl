"""Declare contiguous e2e shards over the current engine test files."""

load("@aspect_rules_js//js:defs.bzl", "js_library", "js_run_binary")
load("//bazel:executors.bzl", "E2E")
load("//bazel:paths.bzl", "bin_relative")

E2E_WORKERS = 3
_PREFIX = "test/e2e/"

def e2e_shard_name(number):
    return "shard_%s%d" % ("0" if number < 10 else "", number)

def _shard_of(path, starts):
    index = 0
    for candidate, start in enumerate(starts):
        if start <= path:
            index = candidate
    return index

def e2e_shards(tests, helpers, starts, helper_deps = [], exec_properties = E2E):
    """Create one cacheable vitest action for each contiguous test-file range."""
    groups = [[] for _ in starts]
    for path in sorted([_PREFIX + test for test in tests]):
        groups[_shard_of(path, starts)].append(path)
    package = native.package_name()
    js_library(
        name = "helpers",
        srcs = helpers,
        deps = helper_deps,
        visibility = ["//packages/engine:__pkg__"],
    )
    native.filegroup(
        name = "shards",
        srcs = [":" + e2e_shard_name(index + 1) for index in range(len(groups))],
    )
    for index, group in enumerate(groups):
        name = e2e_shard_name(index + 1)
        if not group:
            fail("%s has no test files; update tests/e2e/shards.bzl" % name)
        js_library(name = name + "_tests", srcs = [path[len(_PREFIX):] for path in group])
        js_run_binary(
            name = name,
            tool = "//scripts:e2e_shard",
            srcs = [
                ":helpers",
                ":%s_tests" % name,
                "//packages/core/pkg:pkg",
                "//packages/engine:e2e_config",
                "//packages/engine:e2e_fixtures_dist",
                "//packages/engine:e2e_fixture_assets",
                "//packages/engine:e2e_public",
                "//packages/engine:dist",
            ],
            outs = [
                name + "/report.json",
                name + "/shard.json",
                name + "/vitest.log",
            ],
            args = [
                "--engine-dir",
                bin_relative("packages/engine"),
                "--engine-dist",
                bin_relative("packages/engine/dist"),
                "--fixtures-dist",
                bin_relative("packages/engine/e2e_fixtures_dist"),
                "--out-dir",
                bin_relative("%s/%s" % (package, name)),
                "--max-workers",
                str(E2E_WORKERS),
            ] + group,
            exec_properties = exec_properties,
            # A local sandbox links each input back to the execroot, so vitest would see its root in
            # the sandbox and every test file in the execroot, and load itself once per tree.
            # Remote execution and caching are unaffected.
            execution_requirements = {"no-sandbox": "1"},
            mnemonic = "E2eShard",
            progress_message = "e2e %s (%d files)" % (name, len(group)),
            visibility = ["//scripts:__pkg__"],
        )
