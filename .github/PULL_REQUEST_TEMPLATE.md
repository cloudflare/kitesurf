## Summary

What changes, and why? Link the issue where a maintainer agreed to the problem and scope.

## Behavior and API impact

Describe changes to public APIs, CDP behavior, rendering, or compatibility.
Write "None" if behavior does not change.

## Implementation

Describe the implementation at a high level.

## Validation

How did you establish the problem and check the fix? List the exact commands run
and their results, and say what you could not check. Attach before and after
screenshots for rendering changes.

- `pnpm run check`:
- `pnpm run test:e2e <file-substring>`:

## Risks and follow-ups

What could regress? What remains to do?

## Checklist

- [ ] This pull request solves one problem; see CONTRIBUTING.md.
- [ ] Every commit has a `Signed-off-by` line (`git commit -s`); see CONTRIBUTING.md.
- [ ] Added or updated focused tests for behavior changes.
- [ ] Updated documentation and generated files, or confirmed they do not apply.
