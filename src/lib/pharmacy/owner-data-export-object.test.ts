// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  isOwnerDataExportObjectName,
  newOwnerDataExportObjectName,
  storedOwnerDataExportObjectName,
} from './owner-data-export-object';

describe('owner data export object names (DEV-783)', () => {
  it('names each archive with an unguessable token after the job id', () => {
    const first = newOwnerDataExportObjectName('job-1');
    const second = newOwnerDataExportObjectName('job-1');
    expect(first).toMatch(/^owner-data-export-job-1-[0-9a-f]{32}\.zip$/);
    expect(second).not.toBe(first);
    expect(() => newOwnerDataExportObjectName('../job')).toThrow();
  });

  it('reserves the export namespace in any letter case', () => {
    for (const name of [
      'owner-data-export-job-1.zip',
      'OWNER-DATA-EXPORT-job-1.zip',
      newOwnerDataExportObjectName('job-1'),
    ]) {
      expect(isOwnerDataExportObjectName(name)).toBe(true);
    }
    expect(isOwnerDataExportObjectName('my-owner-data-export-notes.pdf')).toBe(false);
  });

  it("accepts only the job's own recorded archive name", () => {
    const tokenized = 'owner-data-export-job-1-0123456789abcdef0123456789abcdef.zip';
    expect(storedOwnerDataExportObjectName('job-1', { filename: tokenized })).toBe(tokenized);
    expect(
      storedOwnerDataExportObjectName('job-1', { filename: 'owner-data-export-job-1.zip' })
    ).toBe('owner-data-export-job-1.zip');
    for (const result of [
      null,
      {},
      { filename: null },
      { filename: tokenized.replace('job-1', 'job-2') },
      { filename: 'owner-data-export-job-1-XYZ.zip' },
      { filename: 'owner-data-export-job-1-0123456789abcdef0123456789abcdef.zip/../x' },
      { filename: 'owner-data-export-job-10123456789abcdef0123456789abcdef.zip' },
    ]) {
      expect(storedOwnerDataExportObjectName('job-1', result)).toBeNull();
    }
  });
});
