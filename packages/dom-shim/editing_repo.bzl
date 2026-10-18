"""Materialize the pinned WPT editing implementation for hermetic bundling."""

def _js_const(text, name):
    return text.partition("const %s = \"" % name)[2].partition('"')[0]

def _wpt_editing_impl(rctx):
    script = rctx.read(rctx.attr.script)
    revision = _js_const(script, "WPT_EDITING_REV")
    path = _js_const(script, "UPSTREAM_PATH")
    rctx.download(
        url = "https://raw.githubusercontent.com/web-platform-tests/wpt/%s/%s" % (revision, path),
        output = path,
        sha256 = _js_const(script, "UPSTREAM_SHA256"),
    )
    patches = rctx.path(rctx.attr.script).dirname.dirname.get_child("patches/wpt-editing")
    rctx.watch_tree(patches)
    files = sorted(
        [file for file in patches.readdir() if file.basename.endswith(".patch")],
        key = lambda file: file.basename,
    )
    for patch in files:
        rctx.patch(patch, strip = 1)
    rctx.file("BUILD.bazel", 'exports_files(["%s"])\n' % path)

wpt_editing = repository_rule(
    implementation = _wpt_editing_impl,
    attrs = {"script": attr.label(mandatory = True, allow_single_file = True)},
)
