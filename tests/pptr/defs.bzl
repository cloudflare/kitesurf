"""Run allow-listed upstream Puppeteer tests as cacheable Bazel shards."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("//bazel:executors.bzl", "PPTR")
load("//bazel:paths.bzl", "bin_relative")

PPTR_SHARDS = 4

def pptr_shard(name, shard, shards = PPTR_SHARDS, exec_properties = PPTR, **kwargs):
    """Run one deterministic round-robin slice of the Puppeteer allow-list."""
    js_run_binary(
        name = name,
        tool = "//scripts:pptr_shard",
        srcs = [
            "//packages/engine:assets",
            "//packages/engine:dist",
        ],
        outs = [name + "/results.json", name + "/pptr-run.log"],
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
        mnemonic = "PptrShard",
        progress_message = "puppeteer shard %d/%d" % (shard, shards),
        visibility = ["//scripts:__pkg__"],
        **kwargs
    )
