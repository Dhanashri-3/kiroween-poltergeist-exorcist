import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.js', 'src/**/*.test.js'],
    environment: 'node'
  }
});
