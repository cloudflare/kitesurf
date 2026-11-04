"""Run each allow-listed Playwright spec file as its own cacheable Bazel action."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("//bazel:executors.bzl", "PW")
load("//bazel:paths.bzl", "bin_relative")

def pw_spec(name, spec, exec_properties = PW, **kwargs):
    """Run one allow-listed spec file on a fresh engine, writing <name>/results.json."""
    js_run_binary(
        name = name,
        tool = "//scripts:pw_spec",
        srcs = [
            "//packages/engine:assets",
            "//packages/engine:dist",
        ],
        outs = [name + "/results.json", name + "/pw-run.log"],
        out_dirs = [name + "/test-results"],
        args = [
            "--spec",
            spec,
            "--dist",
            bin_relative("packages/engine/dist"),
            "--out-dir",
            bin_relative(native.package_name() + "/" + name),
        ] + select({
            "//bazel:keep_deviations_on": ["--keep-deviations"],
            "//conditions:default": [],
        }),
        # Build actions see host variables only through --action_env.
        use_default_shell_env = True,
        exec_properties = exec_properties,
        # Each spec boots an engine; run locally all at once, they time out and drop connections.
        # The reservation only affects local scheduling and is not part of the action key.
        resource_set = "cpu_4",
        mnemonic = "PwSpec",
        progress_message = "playwright %s" % spec,
        visibility = ["//scripts:__pkg__"],
        **kwargs
    )

def pw_html_report(name, specs, exec_properties = PW, **kwargs):
    """Merge the spec actions' blob reports into one Playwright HTML report at <name>/report."""
    js_run_binary(
        name = name,
        tool = "//scripts:pw_html_report",
        srcs = specs,
        out_dirs = [name + "/report"],
        args = [
            "--runs",
            bin_relative(native.package_name()),
            "--out",
            bin_relative(native.package_name() + "/" + name + "/report"),
        ],
        use_default_shell_env = True,
        exec_properties = exec_properties,
        mnemonic = "PwHtmlReport",
        progress_message = "playwright html report",
        **kwargs
    )
