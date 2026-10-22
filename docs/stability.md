# Stability and versioning

`agent-evals` follows [Semantic Versioning](https://semver.org/). While the version is 0.x, the API is young and may still change; this page says how.

## What counts as the public API

- The exports of the package root (`import { … } from '@agent-evals/core'`) and their TypeScript types.
- The CLI: its commands, options and exit codes.
- The file formats: task and suite files (with their JSON Schemas in `schema/`), the transcript JSONL, `run.json`, `summary.json`, the labels file and the reviews file ([Transcript format](transcript-format.md), [Task and suite files](task-and-suite-files.md)).

Everything else is internal and may change in any release: deep imports into the package's files, the viewer's HTTP API, the markup of `report.html` and `report.md`.

## The promise in 0.x

- A **patch** release (0.1.x) never breaks the public API.
- A **minor** release (0.x.0) may break it. Its changelog entry names every breaking change and how to move.
- An export that is going away is **deprecated first**: it keeps working and its documentation says so for at least one minor release before it goes.
- **1.0** comes when two minor releases in a row needed no breaking change. From then on, only a major release breaks the public API.

## File format versions

`run.json` and every line of a transcript file carry a `formatVersion`, today `1` (exported as `FORMAT_VERSION`). The version goes up only with a change an older reader would misread: a field removed, renamed or given a new meaning. New optional fields don't raise it, so a reader ignores fields it doesn't know.

`readRun` (and every command and the viewer, which read runs through it) refuses a file with a newer version and says to upgrade, so an old version of the package never misreads a new file. A file without a version was written before 0.1.0 and reads as version 1. A release that raises the version converts the older files it reads, so a run read and written again is in one format and says which. A release that raises the version is a minor release before 1.0 and a major one after it, and its changelog says so.

## Editor schemas

The JSON Schemas ship with the package. Point an editor at the version you use, for example `https://unpkg.com/@agent-evals/core@0.1/schema/task.schema.json` (once published): pinning the minor keeps the schema in step with what your installed version accepts.
