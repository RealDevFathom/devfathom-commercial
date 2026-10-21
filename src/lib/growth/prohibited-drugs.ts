import dataset from './prohibited-drugs.json';

/** Maintained DRAP provenance and supplemental PK vocabulary live in one data file. */
export const PROHIBITED_DRUG_NAMES: readonly string[] = dataset.names;
