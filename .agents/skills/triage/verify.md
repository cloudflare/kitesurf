# Verify

Decide whether the report describes a real bug, intended behaviour, or a
known limitation.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome.**

**SCOPE: Verification only. No fix. Don't spawn subagents.**

## Prerequisites

- **`triageDir`**, **`issueDetails`**, and `report.md` from the earlier steps.

## The rule: the spec and WPT decide, not Chrome

"Chrome does it differently" is evidence. It does not prove a bug. Decide
on what the standard says:

1. **The spec.** WHATWG HTML and DOM, the CSS specs, ECMAScript, and the
   Chrome DevTools Protocol for CDP behaviour. Quote the section or
   algorithm step.
2. **WPT.** Look for a test that covers the behaviour: search `.wpt/`
   after `pnpm wpt:setup`, or wpt.fyi. Check
   `tests/wpt-expectations.json` for its current pinned outcome. A
   pinned FAIL shows the gap is known. It does not show the gap is
   intended.
3. **Chrome.** Use Chrome when the spec leaves it to the browser
   (scrollbar width, default fonts, timing), or for CDP, where Chrome's
   implementation is the reference.

If Chrome and the spec disagree, the spec wins. Say this in the report.
Chrome's behaviour may still be worth matching as an enhancement.

## Step 1: Identify the claim

From the issue, extract:

- **Current behaviour**: what the reporter sees.
- **Expected behaviour**: what they say should happen. This is the claim
  you are checking.

## Step 2: Look for intent in Kitesurf

Do not assume the reporter is right.

- **`AGENTS.md` "Architecture" and "Out of scope unless asked".** Many
  surprising behaviours are deliberate. For example: eval runs on boa in
  a sub-isolate, state does not survive a WebSocket, JS state does not
  survive a navigate, and `pushState` does not refetch.
- **Code comments that explain why.** Kitesurf's code comments say "on
  purpose", "deliberately" or "by design" when they mean it, and often
  point at the commit or test that pinned the behaviour.
- **Git history.** Run `git blame` on the lines involved, then
  `git show --no-patch <sha>`. A commit body that explains the trade-off
  is strong evidence.
- **Earlier issues and PRs.** `gh search issues "<keywords>"`,
  `gh search prs "<keywords>"`.

## Step 3: Decide

- **`bug`**: the behaviour breaks the spec or WPT, and nothing shows
  that we chose it. Or it is a regression, a crash, a wasm panic, an
  isolate memory blow-up, or a CDP reply that breaks a standard client
  (Puppeteer, Playwright, DevTools).
- **`known-limitation`**: the behaviour breaks the spec, but the README,
  `AGENTS.md` or a code comment lists it as a gap or out of scope. Quote
  the line. "workerd (or a vendored crate) does it this way" is not a
  listed gap. Don't fix it. The reporter may have a fair feature request. Say
  that.
- **`intended-behavior`**: the behaviour follows the spec, or is a
  documented design choice. Chrome doing something else does not change
  this.
- **`unclear`**: you can't tell. Prefer this to a guess.

The question to ask is: did the maintainers know about this behaviour
and choose it? If yes, it is not a bug. "Not perfect" is not the same as
"broken".

## Step 4: Confidence

- **high**: a spec quote or WPT test that settles it, an explicit code
  comment, or a fact or doc entry.
- **medium**: good evidence with some doubt.
- **low**: mostly inference.

## Step 5: Append to `report.md`

- The claim.
- Verdict: `bug`, `intended-behavior`, `known-limitation` or `unclear`.
- Confidence.
- Evidence: spec links and section names, WPT test paths and their
  pinned outcomes, `AGENTS.md` sections, and commit SHAs.
