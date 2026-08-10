import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/electron/**/*.test.ts', 'src/renderer/**/*.test.ts'],
  },
});
