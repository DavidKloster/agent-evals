import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { HumanLabel } from '../core/types.ts';
import { humanLabelSchema } from '../metrics/calibration.ts';

/**
 * Writes the human labels the viewer collects into the labels file that `calibrate` reads (see calibration.ts). The
 * file stays a plain YAML list, so `loadLabels` reads it back; entries of a labelling sheet keep their helper fields.
 */

export const MAX_NOTE = 2000;
export const MAX_LABELLER = 200;
const MAX_FIELD = 500;

/** What identifies a label: one person's verdict on one dimension of one trial. */
export type LabelKey = Pick<
  HumanLabel,
  'suite' | 'taskId' | 'target' | 'trial' | 'grader' | 'dimension'
>;

/** Thrown for input the store refuses; the viewer answers it with 400. */
export class LabelValidationError extends Error {
  override name = 'LabelValidationError';
}

const field = z.string().min(1).max(MAX_FIELD);

// Stricter than the calibration's schema: the input comes from a browser, so every string is bounded.
const inputSchema = z.object({
  suite: z.string().max(MAX_FIELD).optional(),
  taskId: field,
  target: field,
  trial: z.number().int().nonnegative().max(1_000_000),
  grader: field,
  dimension: field,
  label: z.enum(['pass', 'fail', 'unknown']),
  labeller: z.string().max(MAX_LABELLER).optional(),
  note: z.string().max(MAX_NOTE).optional(),
});

const keySchema = inputSchema.pick({
  suite: true,
  taskId: true,
  target: true,
  trial: true,
  grader: true,
  dimension: true,
});

// The file's entries may carry the labelling sheet's helper fields (question, input, answer): keep them.
const fileSchema = z.array(humanLabelSchema.loose());
type FileEntry = z.infer<typeof humanLabelSchema> & Record<string, unknown>;

const LABEL_FIELDS = new Set<string>([
  'suite',
  'taskId',
  'target',
  'trial',
  'grader',
  'dimension',
  'label',
  'labeller',
  'note',
]);

const header = `# Human labels for the model judge's calibration, kept by "agent-evals view".
# Then: agent-evals calibrate <run> --labels <this file>
`;

const keyOf = (label: LabelKey) =>
  [
    label.suite ?? '',
    label.taskId,
    label.target,
    String(label.trial),
    label.grader,
    label.dimension,
  ].join('\u0000');

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
}

/** A label as calibration.ts returns it: no undefined or empty optional fields. */
function clean(label: HumanLabel): HumanLabel {
  return {
    ...(label.suite ? { suite: label.suite } : {}),
    taskId: label.taskId,
    target: label.target,
    trial: label.trial,
    grader: label.grader,
    dimension: label.dimension,
    label: label.label,
    ...(label.labeller ? { labeller: label.labeller } : {}),
    ...(label.note ? { note: label.note } : {}),
  };
}

function readEntries(file: string): FileEntry[] {
  if (!existsSync(file)) return [];
  const data: unknown = parse(readFileSync(file, 'utf8'));
  const list =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as { labels?: unknown }).labels
      : data;
  const result = fileSchema.safeParse(list ?? []);
  if (!result.success) throw new Error(`${file}: invalid labels: ${issues(result.error)}`);
  return result.data;
}

function toLabel(entry: FileEntry): HumanLabel {
  return clean(entry);
}

/** Writes beside the file and renames, so a reader never sees half a file. */
function writeEntries(file: string, entries: FileEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${header}\n${stringify(entries, { lineWidth: 0 })}`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The labels of the file; none when it doesn't exist yet. */
export function readLabelsFile(file: string): HumanLabel[] {
  return readEntries(file).map(toLabel);
}

/** Checks labels from outside (the viewer's POST) and returns them clean. */
export function validateLabels(input: unknown): HumanLabel[] {
  const result = z.array(inputSchema).safeParse(input);
  if (!result.success) throw new LabelValidationError(`invalid labels: ${issues(result.error)}`);
  return result.data.map(clean);
}

/**
 * Adds the labels to the file, replacing any entry with the same key (suite, task, target, trial, grader, dimension),
 * and returns every label of the file.
 */
export function upsertLabels(file: string, labels: HumanLabel[]): HumanLabel[] {
  const incoming = validateLabels(labels);
  const entries = readEntries(file);
  const index = new Map(entries.map((entry, i) => [keyOf(entry), i]));
  for (const label of incoming) {
    const at = index.get(keyOf(label));
    if (at === undefined) {
      index.set(keyOf(label), entries.length);
      entries.push(label as FileEntry);
    } else {
      // Keep the sheet's helper fields, take every label field from the new label.
      const extras = Object.fromEntries(
        Object.entries(entries[at]!).filter(([name]) => !LABEL_FIELDS.has(name)),
      );
      entries[at] = { ...extras, ...label };
    }
  }
  writeEntries(file, entries);
  return entries.map(toLabel);
}

/** Removes the label with the key and returns the labels left. */
export function removeLabel(file: string, key: LabelKey): HumanLabel[] {
  const result = keySchema.safeParse(key);
  if (!result.success) throw new LabelValidationError(`invalid label key: ${issues(result.error)}`);
  const wanted = keyOf(result.data);
  const entries = readEntries(file);
  const left = entries.filter((entry) => keyOf(entry) !== wanted);
  if (left.length !== entries.length) writeEntries(file, left);
  return left.map(toLabel);
}
