"""Run each engine e2e test file as its own cacheable Bazel action."""

load("@aspect_rules_js//js:defs.bzl", "js_library", "js_run_binary", "js_test")
load("//bazel:executors.bzl", "E2E")
load("//bazel:paths.bzl", "bin_relative")

_PREFIX = "test/e2e/"
_SUFFIX = ".e2e.test.ts"

def e2e_files(tests, helpers, helper_deps = [], exec_properties = E2E):
    """Create one vitest action per test file, named after it without the suffix, and :gate.

    Each action writes <name>/report.json and <name>/file.json, and fails when the file fails
    twice, so no flaky result is cached. :gate judges the reports and writes the JUnit report.
    """
    package = native.package_name()
    js_library(
        name = "helpers",
        srcs = helpers,
        deps = helper_deps,
        visibility = ["//packages/engine:__pkg__"],
    )
    names = []
    for test in sorted(tests):
        if not test.endswith(_SUFFIX):
            fail("%s does not end in %s" % (test, _SUFFIX))
        name = test[:-len(_SUFFIX)]
        names.append(name)
        js_library(name = name + "_test", srcs = [test])
        js_run_binary(
            name = name,
            tool = "//scripts:e2e_file",
            srcs = [
                ":helpers",
                ":%s_test" % name,
                "//packages/core/pkg:pkg",
                "//packages/engine:e2e_config",
                "//packages/engine:e2e_fixtures_dist",
                "//packages/engine:e2e_fixture_assets",
                "//packages/engine:e2e_public",
                "//packages/engine:dist",
            ],
            outs = [
                name + "/report.json",
                name + "/file.json",
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
                _PREFIX + test,
            ],
            exec_properties = exec_properties,
            # A local sandbox links each input back to the execroot, so vitest would see its root in
            # the sandbox and every test file in the execroot, and load itself once per tree.
            # Remote execution and caching are unaffected.
            execution_requirements = {"no-sandbox": "1"},
            # Each file boots a Miniflare with several engines; run locally all at once, they time
            # out. The reservation only affects local scheduling and is not part of the action key.
            resource_set = "cpu_4",
            mnemonic = "E2eFile",
            progress_message = "e2e %s" % test,
        )
    native.filegroup(
        name = "files",
        srcs = [":" + name for name in names],
    )
    reports = [":%s/report.json" % name for name in names]
    js_test(
        name = "gate",
        size = "small",
        args = [arg for report in reports for arg in ["--report", "$(rootpath %s)" % report]],
        # An entry point's deps do not reach the runfiles.
        data = ["//scripts:wpt_shared"] + reports + [":%s/file.json" % name for name in names],
        entry_point = "//scripts:e2e_gate",
        visibility = ["//tests/e2e:__pkg__"],
    )
