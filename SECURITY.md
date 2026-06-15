# Security Policy

**Last Updated:** 2026-06-15

## Supported Versions

This project is pre-1.0. Security fixes are applied to the default branch until
a release policy is established.

## Reporting a Vulnerability

Please do not open public issues for exploitable vulnerabilities or exposed
credentials. Report privately to the repository owner, then include:

- affected version or commit;
- steps to reproduce;
- expected and observed impact;
- any relevant logs with secrets removed.

## Credential Handling

Vegito reads model provider credentials from environment variables. Never commit
real values for:

- `DEEPSEEK_API_KEY`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `OPENAI_API_KEY`
- provider-specific `*_BASE_URL` values that reveal private gateways

Use `.env.example` as the public template and keep real local values in `.env`
or your shell profile. `.env`, `.env.*`, `.vegito/`, and the private
`DeepSeek_Anthropic_Integration.md` note are intentionally ignored.

If a provider key was ever committed or pasted into a public issue, rotate it
with the provider immediately.
