# Contributing to mehfil-relay

Thanks for your interest. Contributions are welcome — here's how things work.

## Bug reports

Open an issue on GitHub. Include:
- What you were doing
- What you expected
- What actually happened
- Wrangler / Workers runtime version if relevant

## Pull requests

- Keep PRs focused — one thing per PR
- Match the existing code style (plain JS, no dependencies, no build step)
- The relay is intentionally dumb transport — it must never inspect, decrypt, or log envelope contents
- Test with `wrangler dev` before opening the PR

## Security issues

Please **do not** open a public issue for security vulnerabilities. Reach out on Twitter at [@chirag](https://twitter.com/chirag).

## License

By submitting a PR you agree that your contribution will be licensed under the [MIT License](LICENSE).
