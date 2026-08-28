import type { Config } from 'jest';

export const nestEsmTransform = {
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.[cm]?js$': [
      'babel-jest',
      {
        plugins: [
          '@babel/plugin-transform-modules-commonjs',
          'babel-plugin-transform-import-meta',
        ],
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/)'],
} satisfies Pick<Config, 'transform' | 'transformIgnorePatterns'>;
