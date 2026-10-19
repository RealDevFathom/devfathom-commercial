"""Focused filesystem and literal Dockerignore contract checks; no external calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('aws_context', Path(__file__).parents[1] / 'scripts/aws-context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


class ContextTests(unittest.TestCase):
    def test_comments_strings_templates_and_regex_are_not_imports(self):
        source = r'''// import x from '@/missing-comment';
/* import('@/missing-block'); require('@/missing-require'); */
const a = "import x from '@/missing-string'";
const b = 'require("@/missing-single")';
const c = `import('@/missing-template') ${"from '@/missing-expression-text'"}`;
const d = /import\('missing-regex'\)/;
const e = { from: '@/missing-property', import: '@/missing-key' };
'''
        self.assertEqual(context.scan_imports([{'path': 'src/a.ts', 'text': source}]),
                         {'imports': [], 'errors': []})

    def test_all_module_syntax_and_multiline_line_numbers(self):
        source = '''import './side-effect';
import type {
  Thing
} from './types';
export { value } from './reexport';
export type { Other } from './export-type';
const a = import(
  './dynamic'
);
const b = require /* comment */ ('./required');
import legacy = require('./legacy');
type T = import('./type-query').T;
const c = `text ${import('./inside-template')}`;
const d = import(`./literal-template`);
'''
        result = context.scan_imports([{'path': 'src/a.ts', 'text': source}])
        self.assertEqual(result['errors'], [])
        self.assertEqual([(i['import'], i['line']) for i in result['imports']], [
            ('./side-effect', 1), ('./types', 2), ('./reexport', 5),
            ('./export-type', 6), ('./dynamic', 7), ('./required', 10),
            ('./legacy', 11), ('./type-query', 12), ('./inside-template', 13),
            ('./literal-template', 14),
        ])

    def test_real_missing_modules_fail_after_comment_noise_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'src/app.ts').write_text('''/* import x from './comment'; */
import './present';
import type { Missing } from './absent-type';
const load = () => import('./absent-runtime');
''')
            (root / 'src/present.ts').write_text('export {};\n')
            result = context.audit(root, {'src/app.ts', 'src/present.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual([(e['import'], e['line']) for e in result['errors']],
                             [('./absent-type', 3), ('./absent-runtime', 4)])

    def test_parser_failure_denies_admission(self):
        with patch.object(context.subprocess, 'run', side_effect=FileNotFoundError):
            self.assertEqual(context.scan_imports([{'path': 'src/a.ts', 'text': ''}])['errors'],
                             [{'reason': 'typescript-parser-unavailable-or-failed'}])

    def test_malformed_and_computed_imports_fail_closed(self):
        for source, reason in [("import {", 'source-parse-error'),
                               ('import(moduleName)', 'nonliteral-module-reference'),
                               ('require(`./${name}`)', 'nonliteral-module-reference')]:
            with self.subTest(source=source):
                result = context.scan_imports([{'path': 'src/a.ts', 'text': source}])
                self.assertIn(reason, [e['reason'] for e in result['errors']])

    def test_exact_membership_and_escaped_route(self):
        entries = context.load_allowlist('**\n!src/app/\\[id\\]/page.tsx\n!public/icon.svg\n')
        self.assertIn('src/app/[id]/page.tsx', entries)
        for path in ['src/app/i/page.tsx', 'public/new.svg', 'public/icon.svg/secret', '.env', '.env.example', 'src/.env.production', 'node_modules/a.js', '.git/config', '.agents/a', '.codex/a', '.aws/credentials', 'tests/demo.ts', 'prisma/seed.ts', 'public/uploads/a.png', 'private-uploads/a', 'source.patch', 'evidence/report.json', 'backup.tar.gz', 'dump.sql', 'credentials.json']:
            self.assertNotIn(path, entries, path)

    def test_reject_nonliteral_or_unsafe_rules(self):
        for text in ['!src/app.ts', '**\n!src/**', '**\n!../escape', '**\n!/absolute', '**\n!src\n!src/a.ts', '**\n!a\n!a']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                context.load_allowlist(text)

    def test_real_files_excluded_without_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'public').mkdir()
            (root / 'public/icon.svg').write_text('<svg/>')
            (root / '.env').mkdir()  # Even a non-file forbidden path is never read.
            (root / 'public/upload.png').write_text('inert fixture')
            result = context.audit(root, {'public/icon.svg'})
            self.assertTrue(result['admitted'])
            self.assertEqual(result['includedCount'], 1)
            self.assertEqual(result['excludedCount'], 1)
            self.assertEqual(result['included'][0]['bytes'], 6)

    def test_symlink_and_missing_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'linked.ts').symlink_to('missing.ts')
            result = context.audit(root, {'linked.ts', 'absent.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual({e['reason'] for e in result['errors']}, {'missing', 'not-regular-file'})

    def test_forbidden_exception_rejected_before_content_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env.example').write_text('inert')
            result = context.audit(root, {'.env.example'})
            self.assertEqual(result['included'], [])
            self.assertEqual(result['errors'][0]['reason'], 'prohibited-category')

    def test_import_closure_detects_excluded_demo_and_allows_generated_prisma(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'src/app.ts').write_text("import { x } from '@/lib/demo/personas';\nimport { Prisma } from '@/generated/prisma/client';\n")
            result = context.audit(root, {'src/app.ts'})
            self.assertFalse(result['admitted'])
            self.assertEqual(len(result['errors']), 1)
            self.assertEqual(result['errors'][0]['import'], '@/lib/demo/personas')

    def test_repository_allowlist_has_no_directory_or_prohibited_exceptions(self):
        root = Path(__file__).parents[1]
        entries = context.load_allowlist((root / 'Dockerfile.aws.dockerignore').read_text())
        self.assertGreater(len(entries), 0)
        for path in entries:
            self.assertTrue((root / path).is_file(), path)
            self.assertEqual(context.category(path), 'not-required', path)


if __name__ == '__main__':
    unittest.main()
