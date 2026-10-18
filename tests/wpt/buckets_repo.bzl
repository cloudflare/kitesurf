"""Generate the WPT bucket map from committed public test boundaries."""

def _wpt_buckets_impl(rctx):
    tests = sorted(json.decode(rctx.read(rctx.attr.tests)))
    boundaries = json.decode(rctx.read(rctx.attr.buckets))["buckets"]
    buckets = {bucket["name"]: [] for bucket in boundaries}
    index = 0
    for test in tests:
        for _ in range(len(boundaries)):
            if index + 1 < len(boundaries) and test >= boundaries[index + 1]["first"]:
                index += 1
            else:
                break
        buckets[boundaries[index]["name"]].append(test)
    rctx.file("BUILD.bazel", "")
    populated = {
        name: entries
        for name, entries in buckets.items()
        if entries
    }
    rctx.file("defs.bzl", "BUCKETS = %r\n" % populated)

wpt_buckets = repository_rule(
    implementation = _wpt_buckets_impl,
    attrs = {
        "buckets": attr.label(mandatory = True),
        "tests": attr.label(mandatory = True),
    },
)
