import type { Config } from 'jest';
import { nestEsmTransform } from './test/jest-nest-esm';

const config: Config = {
  ...nestEsmTransform,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/(?!e2e/).*\\.spec\\.ts$',
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageDirectory: './coverage',
  coverageThreshold: {
    global: {
      branches: 77,
      functions: 88,
      lines: 85,
      statements: 85,
    },
  },
  testEnvironment: 'node',
};

export default config;
