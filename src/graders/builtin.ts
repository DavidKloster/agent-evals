import { codeGraders, type FactMatcher } from './code.ts';
import { registry, type GraderRegistry } from './grade.ts';
import { modelGraders } from './judge.ts';

/** Every built-in grader; a project's fact matchers (`amount:`, `date:`) extend `facts` and `forbid`. */
export function builtinGraders(factMatchers: FactMatcher[] = []): GraderRegistry {
  return registry(codeGraders(factMatchers), modelGraders());
}
