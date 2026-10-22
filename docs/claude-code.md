# Claude Code plugin

The repository is also a [Claude Code](https://code.claude.com/docs) plugin marketplace. Its plugin `agent-evals` holds two skills that let Claude set up evals, run them and read the results, and turn an agent's failure into an eval task. The skills are short and link to these docs for the details.

| Skill             | Claude uses it when you…                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `agent-evals`     | add evals to an agent, regression-test a prompt, model or tool change, ask for pass@k or pass^k, or read a run's report          |
| `write-eval-task` | turn a failure, a transcript or a user's report into a task, or ask whether a task belongs in the capability or regression suite |

Claude picks a skill by itself when your request matches. You can also call one by name: `/agent-evals:agent-evals` or `/agent-evals:write-eval-task`.

## Installing

In Claude Code:

```text
/plugin marketplace add DavidKloster/agent-evals
/plugin install agent-evals@agent-evals
```

Claude Code 2.1.275 and later also take it in one step: `/plugin install agent-evals --marketplace DavidKloster/agent-evals`. From a shell, the same commands are `claude plugin marketplace add DavidKloster/agent-evals` and `claude plugin install agent-evals@agent-evals`; `install` takes `--scope project` to share the plugin with everyone who works in the repository.

The plugin's version is the package's: a release bumps both. `claude plugin update agent-evals@agent-evals` (or `/plugin`) fetches a newer one.

The marketplace serves the skills from `main`, while `npx @agent-evals/core` runs the version your project installed (or the latest release). Between two releases, a skill on `main` may already name an option your CLI doesn't have. To keep the two in step, add the marketplace at the release tag of the version you use: `/plugin marketplace add DavidKloster/agent-evals#v0.1.0`.

### Without the plugin system

Each skill is a folder with one `SKILL.md`. Copy a folder from [`plugins/agent-evals/skills/`](../plugins/agent-evals/skills/) into `~/.claude/skills/` (for you) or into your project's `.claude/skills/` (for everyone in it). Copied skills have no plugin namespace, so you call them as `/agent-evals` and `/write-eval-task`.

The `SKILL.md` files follow the open [Agent Skills](https://agentskills.io/specification) format, so other agents that read it can use them too: copy the folders to wherever your agent looks for skills.

## What the skills run

The skills call the CLI as `npx @agent-evals/core <command>`, the same commands as [CLI and config](cli-and-config.md). Until the package is on npm, link a checkout so that `npx` finds it:

```sh
git clone https://github.com/DavidKloster/agent-evals.git
cd agent-evals
npm install
npm run build
npm link
cd ../your-project
npm link @agent-evals/core
```

## Keeping the skills right

The plugin lives in `plugins/agent-evals/`, and the marketplace in `.claude-plugin/marketplace.json`. Neither ships in the npm package: the plugin installs from git, and the package stays the library and the CLI.

`test/plugin.test.ts` reads the skills and fails when one names something that doesn't exist: a CLI command, or an option that command doesn't take; a configuration key; a grader type; a code term the docs never use; a file the package doesn't ship; or a link to a file or heading that isn't in the repository. Renaming a flag in the CLI without changing the skills fails `npm test`. The same test checks the manifests and the skills' format, and CI runs `claude plugin validate --strict` on the marketplace and the plugin.
