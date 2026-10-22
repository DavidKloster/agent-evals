# Contributing

Thanks for helping. This page says how to set up the project, what a pull request needs, and how to propose a grader, an adapter or an eval task.

## Setup

You need Node 22.18 or later (Node strips the TypeScript types itself; there is no build step for development).

```sh
git clone https://github.com/DavidKloster/agent-evals.git
cd agent-evals
npm ci
npm test
```

From a checkout, the CLI runs from source: `node src/cli.ts --help`.

## Before you open a pull request

Run the same checks CI runs:

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run validate:examples
```

- **Tests never call a real model.** Use the `scripted` adapter, a fake `fetch`, or an in-process fake `ChatClient` (see `test/` for examples). CI has no API key.
- **Every runnable sample in the docs is tested.** A fenced block marked `ts doctest` in `README.md` or `docs/` runs as a test (`test/docs.test.ts`), and `yaml task` / `yaml suite` blocks are parsed as task and suite files. Keep them runnable when you change an API.
- **Schemas are generated.** After a change to the task or suite format, run `npm run schema` and commit `schema/`.
- **Synthetic data only** in tests, examples and issues. Never paste real customer data or real transcripts.

## Commits and pull requests

- **Titles follow [Conventional Commits](https://www.conventionalcommits.org/):** `feat(graders): add a json_schema grader`, `fix(harness): …`, `docs: …`. The title becomes the squash commit and the changelog entry. Mark a breaking change with `!` (`feat(config)!: …`) and explain it in the description.
- **Sign off every commit** ([Developer Certificate of Origin](https://developercertificate.org/)): `git commit -s` adds `Signed-off-by: Your Name <you@example.com>`. With it you certify that you wrote the change or have the right to submit it under the project's licence (Apache-2.0). CI checks every commit of a pull request.
- Keep a pull request to one change. Update the docs and the changelog-relevant description in the same pull request.

## Proposing something bigger

Open an issue first for anything that changes the public API or a file format (the task and suite files, the transcript JSONL, `run.json`, the labels or reviews files). The [stability policy](docs/stability.md) says what may change in 0.x.

- **A new grader:** use the "New grader" issue form. Say what it checks, why the existing graders and matchers can't express it, its parameters, and one passing and one failing example. Deterministic graders are preferred; a model grader needs a rubric and a calibration plan.
- **A new adapter:** say which agent or protocol it drives and what it needs. An adapter without dependencies can live in the core package; one that needs a heavy dependency becomes its own package (`@agent-evals/<adapter>`).
- **An eval task for the examples:** use the "Eval task" issue form or open a pull request with the task file and its reference solution; `npm run validate:examples` must pass. Tasks use invented data only.

See [Extending agent-evals](docs/extending.md) for how adapters, graders and fact matchers are written.

## Code of conduct

Everyone in this project follows the [code of conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.
