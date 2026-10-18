# Security policy

Report vulnerabilities privately. Do not open a public issue or pull request.

Use Cloudflare's security reporting channels:

- [Cloudflare disclosure program](https://www.cloudflare.com/disclosure)
- [HackerOne](https://hackerone.com/cloudflare)
- [security@cloudflare.com](mailto:security@cloudflare.com)

Include the commit or version, a minimal reproduction, and the impact you
observed. Do not include sensitive data in a public report.

After this repository is public, you can also report vulnerabilities through
GitHub's private vulnerability reporting in the Security tab.

## Scope

kitesurf renders pages written by others, so these classes of bug are in
scope:

- Escape from a page's isolate into the engine or the host runtime.
- Data that crosses origins or sessions.
- Network requests that a session's configuration does not allow.
- Authentication or authorization bypass on the engine's HTTP or CDP
  endpoints.

The engine has no authentication or rate limit of its own. Anyone who can reach
it can open sessions and make it fetch arbitrary URLs, so an embedder must
supply admission through `EngineHost.admit` or put a gateway in front of it.
