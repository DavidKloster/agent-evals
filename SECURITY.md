# Security policy

## Supported versions

The project is in 0.x. Security fixes go into the latest minor release; upgrade to it to get them.

| Version          | Supported |
| ---------------- | --------- |
| latest 0.x minor | yes       |
| older            | no        |

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you found, how to reproduce it, and what an attacker could do with it. You get an answer within 7 days and a fix, or a decision with its reasons, within 30 days. Once a fix is released, a GitHub security advisory credits you unless you prefer otherwise.

## What is in scope

- The package's code and its published npm tarball (`@agent-evals/core`).
- The local viewer (`agent-evals view`): it is meant to listen on `127.0.0.1` only and refuse cross-site requests; a way around that is a vulnerability.
- Leaks of secrets: the package must never write an API key to a transcript, a report or an error message.

Out of scope: the models and services you evaluate, and the content of your own transcripts. A transcript records everything the agent saw and said; evaluate on synthetic data and treat result folders as sensitive.
