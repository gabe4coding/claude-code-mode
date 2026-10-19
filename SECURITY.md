# Security policy

## Supported versions

Security fixes go on the default branch (`main`) and ship in the next release tag. Older tags do not get a backport, unless that release is still widely installed and the fix is small.

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem. Examples are a sandbox escape, a secret leak, and a permission bypass.

Email: REPLACE_WITH_GABE_SECURITY_EMAIL

Include:

- What you found, and how to reproduce it.
- The plugin version, or the commit SHA.
- The operating system (macOS or Linux) and the Claude Code version, when they matter.

A first reply comes within a few days. Wait a reasonable time before you disclose the problem in public.

You can also use GitHub private vulnerability reporting when this repository has it enabled (Settings → Security → Private vulnerability reporting).

## Scope

- The sandbox has four layers. See [Sandbox](docs/how-it-works.mdx#sandbox). The Node `vm` module is not a security boundary by itself.
- On Linux, the network block runs only when `unshare -rn` works. See [Sandbox](docs/how-it-works.mdx#sandbox).
- A nested MCP call leaves the sandbox. The plugin checks the call against your permission rules, then runs it. See [Permissions](docs/permissions.mdx).
- An approved hint stays for later sessions, and the model follows it. See [Safety rules](docs/hints.mdx#safety-rules).
- An approved saved function stays for later sessions and runs in the sandbox. Each of its MCP calls gets the same permission check. See [Safety rules](docs/functions.mdx#safety-rules).
- Treat approval of a hint or a saved function as a trust decision.
