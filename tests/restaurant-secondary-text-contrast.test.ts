import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// --text-faint is #a3a39e on white in the light theme (2.53:1), below WCAG 1.4.3.
// Restaurant secondary text must use text-text-muted (#6c6c68, >= 4.5:1).
const files = [
  'src/components/restaurant/catalog/catalog-console.tsx',
  'src/app/(app)/restaurant/sop/admin/sop-admin.tsx',
  'src/components/restaurant/menus/menus-console.tsx',
]

describe('restaurant light-theme secondary text contrast', () => {
  it.each(files)('%s does not use text-text-faint', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain('text-text-faint')
  })
})
