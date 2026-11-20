"""Run a client tool with staging inputs built in the execution configuration."""

def _host_run_impl(ctx):
    tool = ctx.attr.tool[DefaultInfo]
    executable = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(
        output = executable,
        target_file = tool.files_to_run.executable,
        is_executable = True,
    )
    runfiles = ctx.runfiles(files = ctx.files.data).merge(tool.default_runfiles)
    runfiles = runfiles.merge_all([target[DefaultInfo].default_runfiles for target in ctx.attr.data])
    return [DefaultInfo(executable = executable, runfiles = runfiles)]

host_run = rule(
    implementation = _host_run_impl,
    executable = True,
    attrs = {
        "tool": attr.label(executable = True, cfg = "target", mandatory = True),
        # Bundlers' native npm dependencies must match the machine building the staged assets.
        "data": attr.label_list(allow_files = True, cfg = "exec"),
    },
)
