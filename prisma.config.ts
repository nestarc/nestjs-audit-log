import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'test/e2e/prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
