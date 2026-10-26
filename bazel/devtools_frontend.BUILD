# The build file of @devtools_frontend, the prebuilt Chrome DevTools frontend from MODULE.bazel.
# The zip is a raw ninja output directory: drop build bookkeeping, the pre-compressed .pak copies,
# test material and the entrypoints other than inspector.html. Keep every module file: DevTools
# lazy-loads panels, so a wrongly pruned file is a 404 inside one panel at runtime.

_PRUNED = [
    # Bazel's own files in the repository root.
    "BUILD.bazel",
    "REPO.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel",
    "**/*.hash",
    "**/*.compressed",
    "**/*.map",
    "**/*.grd",
    # TypeScript and ninja bookkeeping: declarations, tsconfigs, stamps and depfiles.
    "**/*.d.ts",
    "**/*tsconfig*.json",
    "**/*.stamp",
    "**/*.d",
    "**/testing/**",
    "**/fixtures/**",
    "legacy_test_runner/**",
    "devtools_app.html",
    "js_app.html",
    "ndb_app.html",
    "node_app.html",
    "worker_app.html",
    "trace_app.html",
    "device_mode_emulation_frame.html",
    "integration_test_runner.html",
    "**/tests.txt",
    "**/api_tests.txt",
    "**/foundation_tests.txt",
    "**/Tests.js",
    "**/*.test.js",
]

# What inspector.html needs to start. If an upstream change moves one, the build stops here
# instead of shipping a frontend that cannot load.
_REQUIRED = [
    "LICENSE",
    "inspector.html",
    "devtools_compatibility.js",
    "entrypoints/inspector/inspector.js",
    "application_tokens.css",
    "design_system_tokens.css",
]

_FRONTEND = glob(["**"], exclude = _PRUNED)

[
    fail("@devtools_frontend has no %s after pruning; re-check the pin and the prune rules" % f)
    for f in _REQUIRED
    if f not in _FRONTEND
]

filegroup(
    name = "frontend",
    srcs = _FRONTEND,
    visibility = ["//visibility:public"],
)
