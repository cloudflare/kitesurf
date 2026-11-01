"""Generic semantic executor profiles; empty defaults use local execution."""

load("@kitesurf_executor_profiles//:defs.bzl", "EXECUTORS")

RUST = EXECUTORS["rust"]
E2E = EXECUTORS["e2e"]
WPT = EXECUTORS["wpt"]
PW = EXECUTORS["pw"]
PPTR = EXECUTORS["pptr"]

def for_test(pool):
    return {"test." + key: value for key, value in pool.items()}
