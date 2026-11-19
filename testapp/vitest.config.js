// Vitest configuration for the Test_App baseline tests (Task 2.3).
// Run with the pinned template: node backend/node_modules/vitest/vitest.mjs run --root testapp
// Plain object (no imports) because testapp/ has no node_modules of its own. Test files use
// Vitest globals for the same reason. Only tests/ is collected, so Playwright specs in e2e/ and
// backend tests are never picked up.
export default {
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['**/node_modules/**', 'e2e/**'],
    environment: 'node',
    globals: true,
  },
};
