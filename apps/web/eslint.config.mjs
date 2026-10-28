import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', '.root_bak*/**', '**/*.bak*/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts', 'public/**', '**/*.bak/**'],
  },
];

export default eslintConfig;
