import { defineConfig } from 'vitest/config';

import { removeVitestTempDir } from './test/support/remove-vitest-temp-dir.ts';

export default defineConfig({
  plugins: [removeVitestTempDir()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
