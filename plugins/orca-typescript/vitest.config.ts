import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['plugins/orca-typescript/src/**/*.test.ts'],
    testTimeout: 30_000
  }
})
