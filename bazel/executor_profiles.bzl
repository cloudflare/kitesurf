"""Root-module configuration for optional generic execution properties."""

_PROFILES = ["rust", "e2e", "wpt", "pw"]

def _profile_repository_impl(rctx):
    profiles = {
        "rust": rctx.attr.rust,
        "e2e": rctx.attr.e2e,
        "wpt": rctx.attr.wpt,
        "pw": rctx.attr.pw,
    }
    lines = ["EXECUTORS = {"]
    for name in _PROFILES:
        lines.append("    %s: {" % json.encode(name))
        for key in sorted(profiles[name]):
            lines.append("        %s: %s," % (json.encode(key), json.encode(profiles[name][key])))
        lines.append("    },")
    lines.extend(["}", ""])
    rctx.file("defs.bzl", "\n".join(lines))
    rctx.file("BUILD.bazel", 'exports_files(["defs.bzl"])\n')

_profile_repository = repository_rule(
    implementation = _profile_repository_impl,
    attrs = {
        name: attr.string_dict()
        for name in _PROFILES
    },
)

def _executor_profiles_impl(mctx):
    profiles = {name: {} for name in _PROFILES}
    configured = {}
    for mod in mctx.modules:
        for tag in mod.tags.profile:
            if not mod.is_root:
                fail("executor profile %r must be configured by the root module" % tag.name)
            if tag.name not in profiles:
                fail("unknown executor profile %r; expected one of %s" % (tag.name, _PROFILES))
            if tag.name in configured:
                fail("executor profile %r was configured more than once" % tag.name)
            configured[tag.name] = True
            profiles[tag.name] = tag.exec_properties

    _profile_repository(
        name = "kitesurf_executor_profiles",
        rust = profiles["rust"],
        e2e = profiles["e2e"],
        wpt = profiles["wpt"],
        pw = profiles["pw"],
    )

executor_profiles = module_extension(
    implementation = _executor_profiles_impl,
    tag_classes = {
        "profile": tag_class(attrs = {
            "exec_properties": attr.string_dict(),
            "name": attr.string(mandatory = True),
        }),
    },
)
