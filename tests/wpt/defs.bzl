"""Declare public WPT buckets, their run plans, and retry draws."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("//bazel:executors.bzl", "WPT")
load("//bazel:paths.bzl", "bin_relative", "exec_path")

def _tests_json_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode_indent(ctx.attr.tests) + "\n")
    return [DefaultInfo(files = depset([output]))]

_tests_json = rule(
    implementation = _tests_json_impl,
    attrs = {"tests": attr.string_list(mandatory = True)},
)

def wpt_runplan(name, buckets):
    """Project full expectations onto each bucket's run-affecting fields."""
    package = native.package_name()
    js_run_binary(
        name = name,
        tool = "//scripts:wpt_runplan",
        srcs = ["//:wpt_expectations"] + [":" + bucket + "_tests" for bucket in buckets],
        outs = ["%s/%s.json" % (name, bucket) for bucket in buckets],
        args = ["--expectations", exec_path("//:wpt_expectations")] + [
            exec_path(":%s_tests" % bucket) + "=" + bin_relative("%s/%s/%s.json" % (package, name, bucket))
            for bucket in buckets
        ],
        mnemonic = "WptRunplan",
        progress_message = "Projecting WPT expectations onto %d buckets" % len(buckets),
    )

def wpt_bucket(name, tests, runplan = "runplan", engines = 2, exec_properties = WPT, **kwargs):
    """Run one bucket; its expectations projection is the run action's input."""
    _tests_json(name = name + "_tests", tests = tests)
    output = bin_relative(native.package_name() + "/" + name)
    expectations = ":%s/%s.json" % (runplan, name)
    js_run_binary(
        name = name,
        tool = "//scripts:wpt_bucket",
        srcs = [
            ":" + name + "_tests",
            expectations,
            "//:wpt_revision",
            "//packages/engine:assets",
            "//packages/engine:dist",
        ],
        outs = [name + "/results.json", name + "/full.json", name + "/run.json"],
        out_dirs = [name + "/logs"],
        args = [
            "--tests",
            exec_path(":%s_tests" % name),
            "--expectations",
            exec_path(expectations),
            "--dist",
            bin_relative("packages/engine/dist"),
            "--out-dir",
            output,
            "--revision-file",
            exec_path("//:wpt_revision"),
            "-j",
            str(engines),
        ],
        # Build actions see host variables only through --action_env.
        use_default_shell_env = True,
        exec_properties = exec_properties,
        mnemonic = "WptBucket",
        progress_message = "WPT bucket %{label}",
        **kwargs
    )

_SettingInfo = provider("One WPT retry build setting value.", fields = ["value"])

def _setting_impl(ctx):
    return [_SettingInfo(value = ctx.build_setting_value)]

retry_tests_setting = rule(
    implementation = _setting_impl,
    build_setting = config.string_list(flag = True, repeatable = True),
)
retry_int_setting = rule(
    implementation = _setting_impl,
    build_setting = config.int(flag = True),
)
retry_string_setting = rule(
    implementation = _setting_impl,
    build_setting = config.string(flag = True),
)

def _retry_dir(test):
    safe = "".join([char if char.isalnum() else "_" for char in test.elems()])
    return "%s-%d" % (safe[-48:].lstrip("_"), hash(test) & 0x7fffffff)

def _wpt_retry_impl(ctx):
    tests = sorted({test: None for test in ctx.attr._tests[_SettingInfo].value}.keys())
    draws = ctx.attr._draws[_SettingInfo].value
    if draws < 1:
        fail("--//tests/wpt:retry_draws must be at least 1")
    dist = ctx.files._dist[0]
    inputs = depset(
        [ctx.file._expectations, ctx.file._revision, dist] + ctx.files._public,
        transitive = [ctx.attr._bucket_data[OutputGroupInfo].execroot_data_files],
    )
    env = {
        "BAZEL_BINDIR": ctx.bin_dir.path,
        "JS_BINARY__PATCH_NODE_FS": "0",
        "JS_BINARY__USE_EXECROOT_ENTRY_POINT": "1",
        "WPT_RETRY_NONCE": ctx.attr._nonce[_SettingInfo].value,
    }
    manifest = {}
    results = []
    for test in tests:
        subdir = "%s/%s" % (ctx.label.name, _retry_dir(test))
        tests_json = ctx.actions.declare_file(subdir + "/tests.json")
        ctx.actions.write(tests_json, json.encode([test]) + "\n")
        manifest[test] = []
        for draw in range(1, draws + 1):
            output = "%s/%d" % (subdir, draw)
            outputs = [
                ctx.actions.declare_file(output + "/results.json"),
                ctx.actions.declare_file(output + "/run.json"),
                ctx.actions.declare_directory(output + "/logs"),
            ]
            ctx.actions.run(
                executable = ctx.attr._bucket[DefaultInfo].files_to_run,
                inputs = depset([tests_json], transitive = [inputs]),
                outputs = outputs,
                arguments = [
                    "--tests",
                    tests_json.short_path,
                    "--expectations",
                    ctx.file._expectations.short_path,
                    "--dist",
                    dist.short_path,
                    "--out-dir",
                    "%s/%s" % (ctx.label.package, output),
                    "--revision-file",
                    ctx.file._revision.short_path,
                    "-j",
                    "1",
                    "--draw",
                    "--max-wall-ms",
                    "300000",
                ],
                env = env,
                use_default_shell_env = True,
                execution_requirements = {"no-cache": "1"},
                mnemonic = "WptRetry",
                progress_message = "WPT retry draw %d of %s" % (draw, test),
            )
            manifest[test].append(outputs[0].short_path)
            results.append(outputs[0])
    output = ctx.actions.declare_file(ctx.label.name + "/manifest.json")
    ctx.actions.write(output, json.encode_indent({"draws": draws, "tests": manifest}) + "\n")
    return [
        DefaultInfo(
            files = depset([output] + results),
            runfiles = ctx.runfiles([output] + results),
        ),
        OutputGroupInfo(manifest = depset([output])),
    ]

wpt_retry = rule(
    implementation = _wpt_retry_impl,
    doc = "Run each selected test in fresh uncached WPT bucket actions.",
    attrs = {
        "_bucket": attr.label(default = "//scripts:wpt_bucket", executable = True, cfg = "exec"),
        "_bucket_data": attr.label(default = "//scripts:wpt_bucket"),
        "_dist": attr.label(default = "//packages/engine:dist"),
        "_draws": attr.label(default = "//tests/wpt:retry_draws"),
        "_expectations": attr.label(default = "//:wpt_expectations", allow_single_file = True),
        "_nonce": attr.label(default = "//tests/wpt:retry_nonce"),
        "_public": attr.label(default = "//packages/engine:assets"),
        "_revision": attr.label(default = "//:wpt_revision", allow_single_file = True),
        "_tests": attr.label(default = "//tests/wpt:retry_test"),
    },
)

def wpt_merge(name, buckets, full = False, **kwargs):
    """Merge bucket reports and rejudge against the full expectations file."""
    package = native.package_name()
    outputs = [name + "/wpt-results.json"] + ([name + "/wpt-full.json"] if full else [])
    args = [
        "--expectations",
        exec_path("//:wpt_expectations"),
        "--results-out",
        bin_relative("%s/%s" % (package, outputs[0])),
    ]
    sources = ["//:wpt_expectations"]
    for bucket in buckets:
        args += ["--results", exec_path(":%s/results.json" % bucket)]
        sources.append(":%s/results.json" % bucket)
        if full:
            args += ["--full", exec_path(":%s/full.json" % bucket)]
            sources.append(":%s/full.json" % bucket)
    if full:
        args += ["--full-out", bin_relative("%s/%s" % (package, outputs[1]))]
    js_run_binary(
        name = name,
        tool = "//scripts:wpt_merge",
        srcs = sources,
        outs = outputs,
        args = args,
        mnemonic = "WptMerge",
        progress_message = "Merging %d WPT buckets" % len(buckets),
        **kwargs
    )
