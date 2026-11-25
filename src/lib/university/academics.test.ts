// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { degreeProgress, gradePointAverages, weightedMerit } from './academics';

describe('cohort rules', () => {
  it('uses normalized cohort weights and requires the exam if it carries weight', () => {
    expect(weightedMerit(72.5, 93, 60)).toBe(80.7);
    expect(weightedMerit(72.5, null, 100)).toBe(72.5);
    expect(() => weightedMerit(72.5, null, 60)).toThrow('entry examination');
  });
  it('counts repeated and recognized courses once while retaining mandatory requirements', () => {
    const course = {
      course_id: 'math',
      code: 'M101',
      course: 'Mathematics',
      credits: 3,
      required: true,
      term: 'S1',
      grade_revision: 1,
      mark: 40,
    };
    const rows = [
      course,
      { ...course, term: 'S2', mark: 70 },
      { ...course, course_id: 'writing', code: 'W101', grade_revision: null, mark: null },
    ];
    expect(degreeProgress(rows, 50, 6)).toEqual({
      earnedCredits: 3,
      requiredCredits: 6,
      missingRequiredCourses: ['W101'],
      requirementsMet: false,
    });
    expect(degreeProgress(rows, 50, 6, new Set(['writing', 'math'])).requirementsMet).toBe(true);
    expect(degreeProgress(rows, 50, 6, new Set(['writing', 'math'])).earnedCredits).toBe(6);
    expect(degreeProgress(rows, 50, 6, new Set(['writing']), new Set(['math'])).earnedCredits).toBe(
      3
    );
    expect(
      gradePointAverages(rows, [
        [70, 3],
        [50, 2],
        [0, 0],
      ])
    ).toMatchObject({
      cgpa: 3,
      cumulativeCredits: 3,
      term_gpas: [
        { term: 'S1', gpa: 0, credits: 3 },
        { term: 'S2', gpa: 3, credits: 3 },
      ],
    });
  });
});
