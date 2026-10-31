"""Run allow-listed Playwright tests as cacheable Bazel shards."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("//bazel:executors.bzl", "PW")
load("//bazel:paths.bzl", "bin_relative")

PW_SHARDS = 30

def pw_shard(name, shard, shards = PW_SHARDS, exec_properties = PW, **kwargs):
    """Run one deterministic round-robin slice of the Playwright allow-list."""
    js_run_binary(
        name = name,
        tool = "//scripts:pw_shard",
        srcs = [
            "//packages/engine:assets",
            "//packages/engine:dist",
        ],
        outs = [name + "/results.json", name + "/pw-run.log"],
        out_dirs = [name + "/test-results"],
        args = [
            "--shard",
            "%d/%d" % (shard, shards),
            "--dist",
            bin_relative("packages/engine/dist"),
            "--out-dir",
            bin_relative(native.package_name() + "/" + name),
        ],
        # Build actions see host variables only through --action_env.
        use_default_shell_env = True,
        exec_properties = exec_properties,
        mnemonic = "PwShard",
        progress_message = "playwright shard %d/%d" % (shard, shards),
        visibility = ["//scripts:__pkg__"],
        **kwargs
    )

def pw_html_report(name, shards, exec_properties = PW, **kwargs):
    """Merge the shards' blob reports into one Playwright HTML report at <name>/report."""
    js_run_binary(
        name = name,
        tool = "//scripts:pw_html_report",
        srcs = shards,
        out_dirs = [name + "/report"],
        args = [
            "--shards",
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
