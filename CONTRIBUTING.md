# Contributing to code-mode

Small pull requests are welcome.

## Before you start

- Use Node.js 22.13 or later, and macOS or Linux. See [Requirements](docs/installation.mdx#requirements).
- Read [README](README.md) and [Development](docs/development.mdx).
- Search [open issues](https://github.com/gabe4coding/claude-code-mode/issues) before you open a new one.

## How to run locally

1. Clone the repo.
2. Load this folder as a local plugin:

```bash
claude --plugin-dir /path/to/claude-code-mode
```

See [Run from a local folder](docs/installation.mdx#run-from-a-local-folder).

3. From the repo root, run these checks:

```bash
claude plugin validate .
claude plugin test .
node tests/docs.check.mjs
```

`claude plugin validate .` checks the plugin manifest. Run it after a manifest change, and before a release. See [Release](docs/development.mdx#release).

The full list of checks is in [Tests](docs/development.mdx#tests). It also includes the sandbox test, the code rules, the pure-helper types, and the format check.

4. The output projection bench is in [Output projection bench](docs/development.mdx#output-projection-bench). It runs headless Claude Code, so it needs a login. Each run costs API usage. CI does not run the bench.

## What a pull request needs

- Keep the change small. One problem per pull request.
- Add a test, or a docs check, when the change touches behavior.
- Do not add a dependency. This plugin has none.
- Keep the voice of the docs. Use short sentences. Give a measured number only when you have a method.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
