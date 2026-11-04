import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['dist/**','node_modules/**','coverage/**','scripts/**','distribution/**','vm/**','brain/**','eslint.config.mjs','jest*.config.cjs'] },
  eslint.configs.recommended, ...tseslint.configs.recommended,
  { languageOptions: { globals: {...globals.node,...globals.jest} }, rules: { '@typescript-eslint/no-unused-vars': ['error',{argsIgnorePattern:'^_'}], 'no-console':'error' } }
);
