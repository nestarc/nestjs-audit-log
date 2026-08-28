import type { Config } from 'jest';
import { nestEsmTransform } from '../jest-nest-esm';

const config: Config = {
  ...nestEsmTransform,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../..',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
  testEnvironment: 'node',
};

export default config;
