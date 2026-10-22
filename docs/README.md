# Documentation

`agent-evals` evaluates AI agents on the method of Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents). The [README](../README.md) has the overview and a quick start; these pages go deeper.

## Using it

| Page                                                    | For                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Writing tasks and running suites](writing-tasks.md)    | What makes a good task, adding one as a pull request, from a user's report to a task, capability and regression suites, reading transcripts |
| [Task and suite files](task-and-suite-files.md)         | The file formats, field by field, with the JSON Schemas and mock tools                                                                      |
| [Graders](graders.md)                                   | Every built-in grader, the matcher language, scoring and partial credit                                                                     |
| [Metrics](metrics.md)                                   | pass@1, pass@k, pass^k, partial credit, latency, cost, diffs, saturation, graduation and calibration, with the formulas                     |
| [Judges and calibration](judges-and-calibration.md)     | Model graders, rubrics, the Unknown verdict, consensus, pairwise comparison, human labels and the simulated user                            |
| [CLI and config](cli-and-config.md)                     | Every command and option, the config file, the output folder                                                                                |
| [Viewer](viewer.md)                                     | The local viewer: runs, comparisons, transcripts, labelling                                                                                 |
| [Troubleshooting](troubleshooting.md) and [FAQ](faq.md) | Errors you may meet and common questions                                                                                                    |
| [Stability and versioning](stability.md)                | What the public API is, what may change in 0.x, deprecations, format versions                                                               |
| [Comparison](comparison.md)                             | How it relates to other eval tools, and when to choose one of them instead                                                                  |

## Building on it

| Page                                      | For                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| [Architecture](architecture.md)           | The modules and the data flow from a run to a report                            |
| [Extending](extending.md)                 | Writing an adapter, a grader, a fact matcher, a reporter, hooks, a judge client |
| [Transcript format](transcript-format.md) | The transcript JSONL, `run.json`, `summary.json`, the labels and reviews files  |

## Maintaining it

| Page                                                  | For                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Repository design](maintainers/repository-design.md) | Licensing, layout, build, CI, releases, security, governance, the decisions and the launch checklist |
