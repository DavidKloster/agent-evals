import { z } from 'zod';

/**
 * The file formats of a suite (`suite.yaml`) and a task (`tasks/*.yaml`), in YAML or JSON. The JSON Schemas in `schema/`
 * are generated from these (`npm run schema`), so an editor can check a task while it is written.
 */

export const graderSpecSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .describe('The grader: a built-in one (README, "Graders") or one a project registers.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Unique within the task, the suite's default graders counted; defaults to the type (type#2 for the second unnamed one).",
      ),
    weight: z
      .number()
      .nonnegative()
      .optional()
      .describe('The weight in a weighted or hybrid score (default 1).'),
    required: z
      .boolean()
      .optional()
      .describe('In hybrid scoring, this grader must pass whatever the weighted score.'),
  })
  .catchall(z.unknown())
  .describe("One grader with its parameters; the parameters depend on the grader's type.");

export const scoringSchema = z
  .object({
    mode: z.enum(['binary', 'weighted', 'hybrid']),
    threshold: z.number().min(0).max(1).optional().describe('For weighted and hybrid (default 1).'),
  })
  .strict();

const eventSchema = z
  .object({
    type: z.enum(['message', 'model_call', 'tool_call', 'tool_result', 'error', 'note']),
    at: z.number().optional(),
  })
  .catchall(z.unknown())
  .describe('A transcript event (README, "Transcripts").');

export const taskSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lower case letters, digits, ".", "_" and "-"')
      .describe("Unique within the suite; also the trial files' name."),
    description: z.string().optional().describe('What the task checks, in one or two sentences.'),
    source: z
      .string()
      .optional()
      .describe('Where the task comes from: the issue or the real failure.'),
    tags: z.array(z.string()).optional(),
    input: z
      .object({
        turns: z
          .array(z.string().min(1))
          .optional()
          .describe('What the user types, one message per turn.'),
        user: z
          .object({
            persona: z.string().min(1),
            goal: z.string().min(1),
            firstMessage: z.string().optional(),
            maxTurns: z.number().int().positive().optional(),
          })
          .strict()
          .optional()
          .describe('A simulated user (a second model) with a fixed persona and goal.'),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Passed to the adapter as is.'),
      })
      .strict()
      .refine((input) => (input.turns?.length ?? 0) > 0 || input.user !== undefined, {
        message: 'a task needs turns or a simulated user',
      }),
    graders: z
      .array(graderSpecSchema)
      .describe(
        "The task's own graders, after the suite's default graders. May be empty only when the suite has default graders: the loader refuses a task left without any grader, and grader ids that repeat.",
      ),
    scoring: scoringSchema.optional(),
    trials: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    reference: z
      .object({
        transcript: z.array(eventSchema).optional(),
        outcome: z.unknown().optional(),
      })
      .strict()
      .optional()
      .describe('A solution that passes every grader: `agent-evals validate` checks it.'),
  })
  .strict();

export const suiteSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['capability', 'regression']),
    description: z.string().optional(),
    owner: z.string().optional().describe('Who keeps the tasks and graders up to date.'),
    tasks: z
      .array(z.string())
      .optional()
      .describe('Task files or folders relative to the suite file (default: tasks/).'),
    defaults: z
      .object({
        graders: z.array(graderSpecSchema).optional(),
        scoring: scoringSchema.optional(),
        trials: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        context: z
          .union([z.record(z.string(), z.unknown()), z.string()])
          .optional()
          .describe(
            "Merged under every task's input.context (shared mock tools, the system prompt), or a YAML or JSON file of it, relative to the suite file.",
          ),
      })
      .strict()
      .optional(),
    saturation: z
      .object({ threshold: z.number().min(0).max(1) })
      .strict()
      .optional(),
    graduation: z
      .object({ k: z.number().int().positive(), runs: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

export type TaskFile = z.infer<typeof taskSchema>;
export type SuiteFile = z.infer<typeof suiteSchema>;

/** The JSON Schemas of the two file formats. */
export function jsonSchemas(): { task: unknown; suite: unknown } {
  const options = { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' } as const;
  return {
    task: {
      $id: 'task.schema.json',
      title: 'Agent eval task',
      ...z.toJSONSchema(taskSchema, options),
    },
    suite: {
      $id: 'suite.schema.json',
      title: 'Agent eval suite',
      ...z.toJSONSchema(suiteSchema, options),
    },
  };
}
