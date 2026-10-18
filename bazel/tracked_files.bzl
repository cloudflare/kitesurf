"""Expose the tracked public submodule files to checkout-independent Bazel actions."""

def _git(rctx, root, *args):
    result = rctx.execute(["git"] + list(args), working_directory = str(root))
    if result.return_code != 0:
        fail("git %s failed in %s: %s" % (" ".join(args), root, result.stderr))
    return result.stdout

def _tracked_files_impl(rctx):
    public_root = rctx.path(rctx.attr.root_marker).dirname
    index = _git(
        rctx,
        public_root,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
    ).strip()
    rctx.watch(rctx.path(index))
    rctx.file("files.txt", _git(rctx, public_root, "ls-files"))
    rctx.file("BUILD.bazel", """load("@aspect_rules_js//js:defs.bzl", "js_library")

js_library(
    name = "files",
    srcs = ["files.txt"],
    visibility = ["//visibility:public"],
)
""")

tracked_files = repository_rule(
    implementation = _tracked_files_impl,
    attrs = {"root_marker": attr.label(default = Label("//:MODULE.bazel"))},
)
