import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FORMAT_VERSION, type CalibrationReport, type RunResult } from '../core/types.ts';
import { diffRuns } from '../metrics/diff.ts';
import { saturation } from '../metrics/lifecycle.ts';
import { summarize } from '../metrics/stats.ts';
import { htmlReport } from './html.ts';
import { markdownReport, type ReportOptions } from './markdown.ts';
import { failureTable, loadReviews, ungradedTrials } from './reviews.ts';

export interface WriteReportsOptions {
  k?: number;
  /** The reviews file (YAML or JSON) with the failure classes. */
  reviewsFile?: string;
  labelsCalibration?: CalibrationReport;
  /** An earlier run to compare with. */
  baseline?: RunResult;
  examples?: number;
}

export interface ReportPaths {
  run: string;
  summary: string;
  markdown: string;
  html: string;
}

/** Writes `run.json`, `summary.json`, `report.md` and `report.html` into `dir`. */
export function writeReports(
  run: RunResult,
  dir: string,
  options: WriteReportsOptions = {},
): ReportPaths {
  const k = options.k ?? 3;
  const summary = summarize(run, { k });
  const reviews = options.reviewsFile ? loadReviews(options.reviewsFile) : [];
  const diff = options.baseline ? diffRuns(options.baseline, run, { k }) : undefined;
  const report: ReportOptions = {
    k,
    summary,
    reviews,
    diff,
    calibration: options.labelsCalibration,
    examples: options.examples,
  };

  mkdirSync(dir, { recursive: true });
  const paths: ReportPaths = {
    run: join(dir, 'run.json'),
    summary: join(dir, 'summary.json'),
    markdown: join(dir, 'report.md'),
    html: join(dir, 'report.html'),
  };
  // The version first, so a reader sees it at a glance. A run keeps the version it was read with (its content is in
  // that format: readRun converts nothing); a run built in code without one gets the current version.
  const { formatVersion, ...content } = run;
  writeFileSync(
    paths.run,
    `${JSON.stringify({ formatVersion: formatVersion ?? FORMAT_VERSION, ...content }, null, 2)}\n`,
  );
  writeFileSync(
    paths.summary,
    `${JSON.stringify(
      {
        run: run.id,
        summary,
        saturation: saturation(run, summary),
        diff: diff ?? null,
        failures: failureTable(run, reviews),
        ungraded: ungradedTrials(run),
        calibration: options.labelsCalibration ?? null,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(paths.markdown, markdownReport(run, report));
  writeFileSync(paths.html, htmlReport(run, report));
  return paths;
}

/**
 * Reads a run back from its `run.json`, or from the folder that holds it. A file without a `formatVersion` (written
 * before 0.1.0) reads as version 1; a newer version than {@link FORMAT_VERSION} is refused, never misread.
 */
export function readRun(fileOrDir: string): RunResult {
  const file = statSync(fileOrDir).isDirectory() ? join(fileOrDir, 'run.json') : fileOrDir;
  const run = JSON.parse(readFileSync(file, 'utf8')) as RunResult;
  if (!run || typeof run !== 'object' || !Array.isArray(run.trials) || !Array.isArray(run.suites))
    throw new Error(`${file}: not a run (no trials or suites)`);
  if ('formatVersion' in run) {
    const version: unknown = run.formatVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      throw new Error(
        `${file}: formatVersion must be a positive whole number, not ${JSON.stringify(version)}`,
      );
    if (version > FORMAT_VERSION)
      throw new Error(
        `${file}: format version ${version}, newer than the ${FORMAT_VERSION} this version of agent-evals reads: upgrade agent-evals`,
      );
  }
  return { ...run, formatVersion: run.formatVersion ?? 1 };
}
