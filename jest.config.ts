import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/(?!e2e/).*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
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
