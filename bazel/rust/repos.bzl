"""Repository rules for the pinned wasm32 standard library inputs."""

_CRATES_IO = "https://static.crates.io/crates/{name}/{name}-{version}.crate"
_TAR_FLAGS = [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=go-w",
    "--format=gnu",
]

def tar(rctx, args):
    # The reproducible-archive flags above are GNU tar's. macOS ships BSD tar as `tar`, so a
    # Homebrew `gtar` (brew install gnu-tar) comes first. .bazelrc pins the repository PATH to
    # /usr/bin:/bin, so Homebrew's prefixes are listed explicitly.
    tool = None
    for candidate in ["/opt/homebrew/bin/gtar", "/usr/local/bin/gtar"]:
        if rctx.path(candidate).exists:
            tool = candidate
            break
    tool = tool or rctx.which("gtar") or rctx.which("tar")
    if not tool:
        for candidate in ["/usr/bin/tar", "/bin/tar"]:
            if rctx.path(candidate).exists:
                tool = candidate
                break
    if not tool:
        fail("GNU tar is required to package the pinned Rust sources")
    result = rctx.execute([tool] + _TAR_FLAGS + args)
    if result.return_code != 0:
        fail("tar failed (GNU tar is required; on macOS run `brew install gnu-tar`): " + result.stderr)

def registry_packages(text):
    packages = []
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if line == "[[package]]":
            current = {}
            packages.append(current)
        elif line.startswith("["):
            current = None
        elif current != None and " = " in line:
            key, _, value = line.partition(" = ")
            current[key] = value.strip('"')
    return [
        package
        for package in packages
        if package.get("source", "").startswith("registry+") and "checksum" in package
    ]

def vendor_crates(rctx, packages, destination):
    pending = [
        rctx.download(
            url = _CRATES_IO.format(name = package["name"], version = package["version"]),
            output = "dl/%s-%s.tar.gz" % (package["name"], package["version"]),
            sha256 = package["checksum"],
            block = False,
        )
        for package in packages
    ]
    for download in pending:
        download.wait()
    for package in packages:
        key = "%s-%s" % (package["name"], package["version"])
        rctx.extract(
            "dl/%s.tar.gz" % key,
            output = "%s/%s" % (destination, key),
            strip_prefix = key,
        )
        rctx.file(
            "%s/%s/.cargo-checksum.json" % (destination, key),
            json.encode({"files": {}, "package": package["checksum"]}),
            executable = False,
        )
    rctx.delete("dl")

def _toml_array(text, table, key):
    inside = False
    collecting = False
    body = []
    for raw in text.splitlines():
        line = raw.split(" #")[0].strip() if not raw.strip().startswith("#") else ""
        if not collecting and line.startswith("["):
            inside = line == "[%s]" % table
        elif inside and not collecting and line.startswith(key + " ="):
            collecting = True
            line = line.partition("=")[2]
        if collecting:
            body.append(line)
            if line.endswith("]"):
                break
    value = " ".join(body).strip().lstrip("[").rstrip("]")
    items = []
    for _ in range(len(value)):
        value = value.strip().lstrip(",").strip()
        if not value:
            break
        quote = value[0]
        end = value.find(quote, 1)
        if end < 0:
            fail("unterminated TOML string in [%s] %s" % (table, key))
        items.append(value[1:end])
        value = value[end + 1:]
    if not items:
        fail("no %s in [%s]" % (key, table))
    return items

def _wasm_std_repo_impl(rctx):
    rctx.download_and_extract(
        url = rctx.attr.rust_src_url,
        sha256 = rctx.attr.rust_src_sha256,
        output = "src",
        strip_prefix = "rust-src-nightly/rust-src/lib/rustlib/src/rust",
    )
    vendor_crates(rctx, registry_packages(rctx.read("src/library/Cargo.lock")), "src/vendor")
    tar(rctx, ["-cf", "std-src.tar", "-C", "src", "library", "vendor"])
    rctx.delete("src")
    config = rctx.read(rctx.attr.cargo_config)
    rctx.file("flags.bzl", "\n".join([
        "BUILD_STD = %s" % json.encode(_toml_array(config, "unstable", "build-std")),
        "RUSTFLAGS = %s" % json.encode(
            _toml_array(config, "target.wasm32-unknown-unknown", "rustflags"),
        ),
        "",
    ]))
    rctx.file("BUILD.bazel", """load("@kitesurf//bazel/rust:std.bzl", "wasm_std")
load("@rules_rust//rust:toolchain.bzl", "rust_stdlib_filegroup")

exports_files(["flags.bzl"])

wasm_std(name = "std", src = "std-src.tar")

rust_stdlib_filegroup(
    name = "rust_std",
    srcs = [":std"],
    visibility = ["//visibility:public"],
)
""")

wasm_std_repo = repository_rule(
    implementation = _wasm_std_repo_impl,
    attrs = {
        "cargo_config": attr.label(mandatory = True, allow_single_file = True),
        "rust_src_sha256": attr.string(mandatory = True),
        "rust_src_url": attr.string(mandatory = True),
    },
)
