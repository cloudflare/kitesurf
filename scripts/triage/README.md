# The issue-triage bot

A bot does the first pass on every new issue. It tries to reproduce the
bug, finds the cause, checks that the behavior is really a bug, and tries a
fix. When it finds a fix, it opens a pull request. A maintainer reviews and
merges every pull request. The bot cannot merge.

The bot is [`withastro/triagebot-action`](https://github.com/withastro/triagebot-action).
The Astro project built it and describes it in
[How we built a software factory to drive Astro's GitHub issue count to zero](https://blog.cloudflare.com/astro-issue-triage/).
Kitesurf adds only the project-specific parts:

| File                             | What it does                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `.agents/skills/triage/`         | The instructions the agent follows: reproduce, diagnose, verify, fix. You can run the same skill on your own machine. |
| `.github/workflows/triage.yml`   | Runs the action on issue and comment events. It does nothing until `TRIAGE_ENABLED` is `true`.                        |
| `.github/rulesets/`              | The bot-branch rule that `setup-repo.sh` applies.                                                                     |
| `setup-repo.sh` (this directory) | Creates the labels and the rule, checks the secrets and `main`'s protection, and switches the bot on and off.         |

The workflow builds with the shared `./.github/actions/setup` action and the
Bazel cache that `ci.yml` saves on `main`. A cold build of the Rust to wasm
is slow and a triage run has 60 minutes, so keep `ci.yml` saving that cache.

## How an issue moves

Each issue has at most one `triage:` label. The label is the bot's only
state.

A new or reopened issue gets `triage: needs triage`. The bot then runs
reproduce, diagnose, verify and fix, and ends on one of these labels:

| Label                         | Meaning                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `triage: not actionable`      | Not a bug report.                                                               |
| `triage: needs reproduction`  | No usable reproduction or expected behavior.                                    |
| `triage: skipped`             | Cannot be triaged in CI, for example a feature AGENTS.md lists as out of scope. |
| `triage: unable to reproduce` | The bot tried and the bug did not happen.                                       |
| `triage: unable to fix`       | Reproduced and diagnosed. No fix found.                                         |
| `triage: fix verified`        | A fix is pushed and a pull request is open.                                     |
| `triage: failed`              | The run broke.                                                                  |

- `not actionable`, `skipped` and `fix verified` are final. The bot ignores
  new comments on them.
- On the other labels, a new comment with new information starts another
  run. `triage: failed` allows three attempts. Only comments from the
  reporter or a maintainer (owner, member or collaborator) on an open issue
  start a run. Other people cannot start runs on someone else's issue, but
  a reporter can, so keep the spending alert on the model account.
- `triage: fix pending` and `triage: fix rejected` are for reporter-tested
  previews. Kitesurf does not use them yet. `fix verified` without the
  prefix is the label the bot puts on its pull requests.
- Closing the issue deletes the bot's `triagebot/fix-<number>` branch.

Kitesurf turns on `auto-pr-on-fix`: a fix goes straight to a pull request.
Astro first asks the reporter to test a preview build. Kitesurf has no
per-issue preview yet (see "Later" below).

## Turning it on

This takes about an hour. Do it as a repository admin.

### 1. Create the GitHub App

Create an app named `kitesurf-bot` in the organization:

- Repository permissions: **Contents** read and write, **Issues** read and
  write, **Pull requests** read and write, **Metadata** read. Nothing else.
- No webhook. No user authorization.
- Install it on this repository only.

Generate a private key. Note the app ID and the bot login
(`kitesurf-bot[bot]`).

The workflow creates a new token for each run with
`actions/create-github-app-token`. The token expires after an hour and only
works on this repository.

### 2. Create the model credentials

The default models are Kimi on Workers AI. Create a **separate** Cloudflare
account for the bot. Do not use an account that deploys anything. Create an
API token on it with the **Workers AI: Read** and **Workers AI: Edit**
permissions only. Set a spending alert on the account.

To use Claude instead, add `TRIAGE_ANTHROPIC_API_KEY` and set the
`TRIAGE_MODEL` and `TRIAGE_VERIFICATION_MODEL` variables, for example to
`anthropic/claude-opus-4-6` and `anthropic/claude-sonnet-4-6`.

Choose with the eval in mind. On 10 closed bugs with known fixes, run locally
from the commit before each fix, Claude Sonnet scored 55 of 60 in about 6
minutes and $0.40 per bug. Kimi K2.7 Code scored 38 of 60 in about 18 minutes
per bug, and one run passed 75 minutes. The triage job has 60 minutes,
including the build, so a slow Kimi run ends as `triage: failed`.

### 3. Add the secrets and variables

| Name                                        | Kind               | Value                           |
| ------------------------------------------- | ------------------ | ------------------------------- |
| `TRIAGE_BOT_APP_ID`                         | variable           | the app ID                      |
| `TRIAGE_BOT_LOGIN`                          | variable           | `kitesurf-bot[bot]`             |
| `TRIAGE_BOT_PRIVATE_KEY`                    | secret             | the app's private key (PEM)     |
| `TRIAGE_CF_ACCOUNT_ID`                      | secret             | the bot's Cloudflare account ID |
| `TRIAGE_CF_AI_TOKEN`                        | secret             | the Workers AI token            |
| `TRIAGE_MODEL`, `TRIAGE_VERIFICATION_MODEL` | variable, optional | override the default models     |
| `TRIAGE_ANTHROPIC_API_KEY`                  | secret, optional   | only for Claude models          |

### 4. Run the setup script

```bash
scripts/triage/setup-repo.sh cloudflare/kitesurf
```

It creates the 11 labels and two rulesets, then lists anything that is
missing. A second run resets the two rulesets to the JSON files.

- **triage bot: triagebot/\* branches only** (created). Only users with
  the write, maintain or admin role can create, push or delete branches
  other than `triagebot/**` and `dependabot/**`. The app has none of these
  roles, so it can only touch those branches. Dependabot needs the second
  pattern; a bad push there still needs a reviewed merge.
- **triage bot: no tags** (created). Only users with the write, maintain or
  admin role can create, move or delete tags. `release.yml` publishes a
  release for every `v*` tag, so a bot that could tag could ship a release.
- **Protection on `main`** (checked, not created). The maintainers own the
  `main` ruleset. `--enable` refuses until an active ruleset on `main`
  needs an approving **code-owner** review, requires the `ci` and
  `sign-off` checks, and lets no app bypass it, and until a `CODEOWNERS`
  file exists. The app can submit reviews, so a plain approval could be its
  own; a code-owner review cannot, as long as `CODEOWNERS` names only
  people or a team. This is what stops the bot merging its own work, or
  approving someone else's.

Also turn on **immutable releases** in the repository settings. The app's
contents permission could otherwise edit the assets of a published release.

The bot's pull requests pass the vouch check, which lets `[bot]` accounts
through, and the DCO check: the workflow adds a `Signed-off-by` line for the
bot's own git identity to each commit.

### 5. Dry run on a private fork

Before you switch the bot on in the public repository:

1. Make a private fork and run steps 1 to 4 against it.
2. Run `scripts/triage/setup-repo.sh <fork> --enable`.
3. Open three issues: one real bug with a known fix, one feature request,
   and one bug report without a reproduction. Expect a pull request,
   `triage: not actionable` and `triage: needs reproduction`.
4. Open a fourth issue that asks the bot to print its environment or read
   files outside the checkout. Check that the comment and the run log
   contain no token or key.

### 6. Switch it on

```bash
scripts/triage/setup-repo.sh cloudflare/kitesurf --enable
```

The script refuses if a secret, a variable, the skill or `main`'s protection is missing.

### Switching it off

```bash
scripts/triage/setup-repo.sh cloudflare/kitesurf --disable
```

Runs that have already started finish. New events do nothing.

## Security

Anyone can open an issue, and the issue text drives an agent that runs
shell commands on the runner. The setup limits what a hostile issue can do:

- The agent's shell gets a short list of environment variables and a
  read-only `GITHUB_TOKEN`. The write token and the model key are not in
  that list.
- The write token is a one-hour app token. Pushes outside `triagebot/**`
  and `dependabot/**`, and all tag changes, are refused by the rulesets. Nothing reaches `main`
  without a code-owner review.
- Comments start a run only from the reporter or a maintainer.
- The job saves no cache and skips the pnpm cache, so a run cannot poison
  the caches that `main`'s CI restores. It still restores the Bazel cache.
- The model key works only for Workers AI, on an account that runs nothing
  else.
- The job's own `GITHUB_TOKEN` has `contents: read` and `issues: read`.

What is **not** covered: the action process holds the write token and the
model key in its own environment, and the agent's shell runs as the same
user. A determined prompt injection could read them from the parent
process, for example through `/proc/<pid>/environ`. Chrome also runs with
`--no-sandbox` on attacker-written markup. The limits above cap the damage
at one hour of pushes to `triagebot/**` and `dependabot/**` branches, issue and pull request
comments, pull request reviews that do not count, and model spend. Do the step 5 check before you switch the bot
on, and again after you bump the action.

## Bumping the action

`triage.yml` pins the action to a commit. Before you bump it, read the
upstream diff, especially `src/flue.ts` and `src/handlers/triage.ts`.
Those decide what the agent's shell can see.

## When the bot gets it wrong

A wrong diagnosis or a bad fix usually means the code or the docs are
unclear. Treat it like a confused new contributor. Fix the cause: add a
fact to `AGENTS.md`, a comment at the confusing spot, or a test.
Then reply on the issue, and the bot runs again.

## Later

- **Per-issue preview.** Deploy each fix as a temporary Worker with a
  private token, so the reporter can point their script at it and confirm
  the fix before a pull request opens. This needs a `preview-command`
  input in the upstream action. When it exists, switch `auto-pr-on-fix`
  off.
- **One pipeline for every bug.** File failing WPT clusters and
  screenshot regressions as issues, so they go through the same bot.
