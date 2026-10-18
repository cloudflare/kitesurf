"""Paths for build actions that run from the root of the output tree.

js_run_binary actions without a chdir start in bazel-out/<config>/bin. A path written relative to
this repository is only right there when this is the main repository: as an external module, its
outputs live under external/<repo>/. $(rootpath) has the same problem, so labels use exec_path.
"""

def bin_relative(path):
    """Returns `path`, relative to this repository's root, relative to the output tree's root."""
    repo = native.repo_name()
    return "external/%s/%s" % (repo, path) if repo else path

def exec_path(label):
    """Returns the location of `label`'s file from the output tree's root, in any repository."""

    # bazel-out/<config>/bin is three directories below the exec root.
    return "../../../$(execpath %s)" % label
