"""Resolve Cargo workspace members with the repository's patched registry crates."""

_CRATES_IO = "https://static.crates.io/crates/{name}/{name}-{version}.crate"
_CRATES_IO_API = "https://static.crates.io/crates/{name}/{version}/download"

def _patched_crate_impl(rctx):
    key = "%s-%s" % (rctx.attr.crate, rctx.attr.version)
    rctx.download_and_extract(
        url = _CRATES_IO.format(name = rctx.attr.crate, version = rctx.attr.version),
        sha256 = rctx.attr.sha256,
        type = "tar.gz",
        strip_prefix = key,
    )
    manifest = rctx.read("Cargo.toml")
    if not [line for line in manifest.splitlines() if line.startswith("[workspace]")]:
        rctx.file("Cargo.toml", manifest + "\n[workspace]\n", executable = False)
    series = rctx.path(rctx.attr.patches_marker).dirname.get_child(key)
    rctx.watch_tree(series)
    patches = sorted(
        [path for path in series.readdir() if path.basename.endswith(".patch")],
        key = lambda path: path.basename,
    )
    for patch in patches:
        rctx.patch(patch, strip = 1)
    rctx.file("BUILD.bazel", "")

_patched_crate = repository_rule(
    implementation = _patched_crate_impl,
    attrs = {
        "crate": attr.string(mandatory = True),
        "patches_marker": attr.label(mandatory = True),
        "sha256": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)

def _cargo_workspace_impl(rctx):
    patched = {name: rctx.path(label).dirname for name, label in rctx.attr.patched.items()}
    stamp = []
    spec = {}
    for name in sorted(patched):
        stamp.append(rctx.read(patched[name].get_child("Cargo.toml")))
        key = rctx.attr.keys[name]
        series = rctx.path(rctx.attr.patches_marker).dirname.get_child(key)
        spec["%s %s" % (name, key[len(name) + 1:])] = {
            "patches": [
                str(
                    rctx.attr.patches_marker.same_package_label(
                        "patches/%s/%s" % (key, path.basename),
                    ),
                )
                for path in sorted(series.readdir(), key = lambda path: path.basename)
                if path.basename.endswith(".patch")
            ],
            "sha256": rctx.attr.sha256[key],
        }

    lines = []
    section = None
    for line in rctx.read(rctx.attr.manifest).splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
        if section == "[workspace]" and stripped.startswith("members ="):
            line = "members = %s" % json.encode(sorted(rctx.attr.members.keys()))
        elif section == "[patch.crates-io]" and "vendor-patched/" in line:
            name = stripped.partition("=")[0].strip()
            path = stripped.partition('path = "')[2].partition('"')[0]
            rctx.symlink(patched.pop(name), path)
        lines.append(line)
    if patched:
        fail(
            "patched crates missing from [patch.crates-io] in %s: %s" %
            (rctx.attr.manifest, patched.keys()),
        )

    for member, manifest in rctx.attr.members.items():
        text = rctx.read(manifest)
        stamp.append(text)
        rctx.file(member + "/Cargo.toml", text, executable = False)
        rctx.file(member + "/src/lib.rs", "", executable = False)
    lines.append("# input hash: %d" % hash("".join(stamp) + json.encode(spec)))
    rctx.file("Cargo.toml", "\n".join(lines) + "\n", executable = False)
    rctx.file("Cargo.lock", rctx.read(rctx.attr.lockfile), executable = False)

    result = rctx.execute(
        [rctx.path(rctx.attr._cargo), "update", "--workspace", "--quiet"],
        environment = {
            "CARGO_HOME": str(rctx.path(".cargo-home")),
            "RUSTC": str(rctx.path(rctx.attr._rustc)),
        },
    )
    if result.return_code != 0:
        fail("cargo update --workspace failed: " + result.stderr)
    rctx.delete(".cargo-home")
    rctx.file("patched.json", json.encode_indent(spec), executable = False)
    rctx.file("BUILD.bazel", 'exports_files(["Cargo.toml", "Cargo.lock"])\n')

_cargo_workspace = repository_rule(
    implementation = _cargo_workspace_impl,
    attrs = {
        "keys": attr.string_dict(mandatory = True),
        "lockfile": attr.label(mandatory = True, allow_single_file = True),
        "manifest": attr.label(mandatory = True, allow_single_file = True),
        "members": attr.string_keyed_label_dict(mandatory = True),
        "patched": attr.string_keyed_label_dict(mandatory = True),
        "patches_marker": attr.label(mandatory = True),
        "sha256": attr.string_dict(mandatory = True),
        "_cargo": attr.label(default = "@rust_tools//:bin/cargo"),
        "_rustc": attr.label(default = "@rust_tools//:bin/rustc"),
    },
)

def _registry_packages(lock):
    packages = []
    package = None
    for line in lock.splitlines():
        if line.startswith("["):
            if package:
                packages.append(package)
            package = {} if line == "[[package]]" else None
        elif package != None and line.partition(" = ")[0] in (
            "name",
            "version",
            "source",
            "checksum",
        ):
            key, _, value = line.partition(" = ")
            package[key] = value.strip('"')
    if package:
        packages.append(package)
    return [item for item in packages if item.get("source", "").startswith("registry+")]

def _manifest_stub(rctx, source, destination):
    rctx.file(
        destination + "/Cargo.toml",
        rctx.read(source.get_child("Cargo.toml")),
        executable = False,
    )
    for file in ["build.rs", "src/lib.rs", "src/main.rs"]:
        if source.get_child(file).exists:
            rctx.file(destination + "/" + file, "", executable = False)
    for directory in ["benches", "examples", "src/bin", "tests"]:
        path = source.get_child(directory)
        if not path.is_dir:
            continue
        for child in path.readdir():
            if child.is_dir and child.get_child("main.rs").exists:
                rctx.file(
                    destination + "/" + directory + "/" + child.basename + "/main.rs",
                    "",
                    executable = False,
                )
            elif child.basename.endswith(".rs") and not child.is_dir:
                rctx.file(
                    destination + "/" + directory + "/" + child.basename,
                    "",
                    executable = False,
                )

def _cargo_vendor_impl(rctx):
    packages = _registry_packages(rctx.read(rctx.attr.lockfile))
    pending = [
        rctx.download(
            url = _CRATES_IO_API.format(name = package["name"], version = package["version"]),
            output = "crates/%s-%s.tar.gz" % (package["name"], package["version"]),
            sha256 = package["checksum"],
            block = False,
        )
        for package in packages
    ]
    for download in pending:
        download.wait()
    for package in packages:
        key = "%s-%s" % (package["name"], package["version"])
        rctx.extract("crates/%s.tar.gz" % key, output = "crates/" + key, strip_prefix = key)
        _manifest_stub(rctx, rctx.path("crates/" + key), "vendor/" + key)
        rctx.file(
            "vendor/%s/.cargo-checksum.json" % key,
            json.encode({"files": {}, "package": package["checksum"]}),
            executable = False,
        )
    rctx.delete("crates")
    for key, label in rctx.attr.patched.items():
        _manifest_stub(rctx, rctx.path(label).dirname, "patched/" + key)
    names = sorted(["%s-%s" % (package["name"], package["version"]) for package in packages])
    rctx.file("vendor.json", json.encode_indent(names), executable = False)
    rctx.file("BUILD.bazel", """exports_files(["vendor.json"])

filegroup(
    name = "vendor",
    srcs = glob(["patched/**", "vendor/**"]) + ["vendor.json"],
    visibility = ["//visibility:public"],
)
""")

_cargo_vendor = repository_rule(
    implementation = _cargo_vendor_impl,
    attrs = {
        "lockfile": attr.label(mandatory = True, allow_single_file = True),
        "patched": attr.string_keyed_label_dict(mandatory = True),
    },
)

def _patched_dirs(manifest):
    dirs = []
    in_patch = False
    for line in manifest.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_patch = stripped == "[patch.crates-io]"
        elif in_patch and "vendor-patched/" in line:
            name = stripped.partition("=")[0].strip()
            path = stripped.partition('path = "')[2].partition('"')[0]
            dirs.append((name, path.rpartition("/")[2]))
    return dirs

def _cargo_workspaces_impl(mctx):
    for mod in mctx.modules:
        for tag in mod.tags.patched:
            pinned = dict(tag.sha256)
            patched = {}
            keys = {}
            for name, key in _patched_dirs(mctx.read(tag.manifest)):
                if key not in pinned:
                    fail(
                        "%s is patched in %s but has no sha256 in MODULE.bazel" %
                        (key, tag.manifest),
                    )
                _patched_crate(
                    name = "patched_" + key,
                    crate = name,
                    version = key[len(name) + 1:],
                    sha256 = pinned.pop(key),
                    patches_marker = tag.patches_marker,
                )
                patched[name] = "@patched_%s//:BUILD.bazel" % key
                keys[name] = key
            if pinned:
                fail(
                    "MODULE.bazel pins crates no longer patched in %s: %s" %
                    (tag.manifest, pinned.keys()),
                )
            for vendor in mod.tags.vendor:
                _cargo_vendor(
                    name = vendor.name,
                    lockfile = vendor.lockfile,
                    patched = {keys[name]: label for name, label in patched.items()},
                )
            for workspace in mod.tags.workspace:
                _cargo_workspace(
                    name = workspace.name,
                    manifest = tag.manifest,
                    lockfile = workspace.lockfile,
                    members = workspace.members,
                    keys = keys,
                    patched = patched,
                    patches_marker = tag.patches_marker,
                    sha256 = tag.sha256,
                )

cargo_workspaces = module_extension(
    implementation = _cargo_workspaces_impl,
    tag_classes = {
        "patched": tag_class(attrs = {
            "manifest": attr.label(mandatory = True),
            "patches_marker": attr.label(mandatory = True),
            "sha256": attr.string_dict(mandatory = True),
        }),
        "vendor": tag_class(attrs = {
            "lockfile": attr.label(mandatory = True),
            "name": attr.string(mandatory = True),
        }),
        "workspace": tag_class(attrs = {
            "lockfile": attr.label(mandatory = True),
            "members": attr.string_keyed_label_dict(mandatory = True),
            "name": attr.string(mandatory = True),
        }),
    },
)
