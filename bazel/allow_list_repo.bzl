"""Generate a lane's spec list from its committed allow-list, one Bazel action per entry."""

def _allow_list_specs_impl(rctx):
    entries = json.decode(rctx.read(rctx.attr.tests))
    specs = [entry if type(entry) == "string" else entry["file"] for entry in entries]
    rctx.file("BUILD.bazel", "")
    rctx.file("defs.bzl", "SPECS = %r\n" % specs)

allow_list_specs = repository_rule(
    implementation = _allow_list_specs_impl,
    attrs = {
        "tests": attr.label(mandatory = True),
    },
)
