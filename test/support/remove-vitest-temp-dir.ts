import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** The part of the Vitest instance this plugin reads. `_tmpDir` is private to Vitest. */
interface VitestInstance {
  _tmpDir?: unknown;
  onClose: (fn: () => void) => void;
}

/**
 * Removes the directory Vitest 5 leaves in the OS temp folder on every run: its fork pool hands transformed modules to
 * the workers as files in `<tmp>/<random>/`, and it never removes the root instance's directory. On a host whose
 * `/tmp` is memory (tmpfs), thousands of runs fill it. The path is private to Vitest, so it is checked before anything
 * is deleted: when a Vitest update moves it, the run fails here and says what to check, instead of leaking again.
 */
export function removeVitestTempDir() {
  return {
    name: 'agent-evals:remove-vitest-temp-dir',
    configureVitest({ vitest }: { vitest: VitestInstance }) {
      const directory = vitest._tmpDir;
      if (typeof directory !== 'string' || resolve(dirname(directory)) !== resolve(tmpdir())) {
        throw new Error(
          'removeVitestTempDir: Vitest no longer keeps its temp directory in `_tmpDir` directly under the OS ' +
            'temp folder. Check whether this Vitest version removes it after a run; then drop the plugin, ' +
            'or point it at the new place.',
        );
      }
      const remove = () => rmSync(directory, { recursive: true, force: true });
      vitest.onClose(remove);
      process.once('exit', remove);
    },
  };
}
