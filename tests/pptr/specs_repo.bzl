"""Generate the Puppeteer spec list from the committed allow-list."""

def _pptr_specs_impl(rctx):
    entries = json.decode(rctx.read(rctx.attr.tests))
    specs = [entry if type(entry) == "string" else entry["file"] for entry in entries]
    rctx.file("BUILD.bazel", "")
    rctx.file("defs.bzl", "PPTR_SPECS = %r\n" % specs)

pptr_specs = repository_rule(
    implementation = _pptr_specs_impl,
    attrs = {
        "tests": attr.label(mandatory = True),
    },
)
