import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'src/api/schema.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Screens read the on-device database in effects and set state when it answers. That is the intended
    // pattern for local-first data here; the rule targets effects that derive state from props synchronously.
    files: ['src/ui/**/*.tsx'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
)
