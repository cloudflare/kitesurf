"""Run each allow-listed upstream Puppeteer spec file as its own cacheable Bazel action."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("//bazel:executors.bzl", "PPTR")
load("//bazel:paths.bzl", "bin_relative")

def pptr_test_project(name, exec_properties = PPTR, **kwargs):
    """Patch and build Puppeteer's test project once, for every pptr_spec to copy."""
    js_run_binary(
        name = name,
        tool = "//scripts:pptr_build",
        out_dirs = [name],
        args = [
            "--out-dir",
            bin_relative(native.package_name() + "/" + name),
        ],
        # Build actions see host variables only through --action_env.
        use_default_shell_env = True,
        exec_properties = exec_properties,
        mnemonic = "PptrBuild",
        progress_message = "puppeteer test project",
        **kwargs
    )

def pptr_spec(name, spec, test_project, exec_properties = PPTR, **kwargs):
    """Run one allow-listed spec file on a fresh engine, writing <name>/results.json.

    test_project names this package's pptr_test_project target.
    """
    js_run_binary(
        name = name,
        tool = "//scripts:pptr_spec",
        srcs = [
            ":" + test_project,
            "//packages/engine:assets",
            "//packages/engine:dist",
        ],
        outs = [name + "/results.json", name + "/pptr-run.log"],
        out_dirs = [name + "/test-results"],
        args = [
            "--spec",
            spec,
            "--test-project",
            bin_relative(native.package_name() + "/" + test_project),
            "--dist",
            bin_relative("packages/engine/dist"),
            "--out-dir",
            bin_relative(native.package_name() + "/" + name),
        ],
        use_default_shell_env = True,
        exec_properties = exec_properties,
        # Each spec boots an engine; run locally all at once, they time out and drop connections.
        # The reservation only affects local scheduling and is not part of the action key.
        resource_set = "cpu_4",
        mnemonic = "PptrSpec",
        progress_message = "puppeteer %s" % spec,
        visibility = ["//scripts:__pkg__"],
        **kwargs
    )
