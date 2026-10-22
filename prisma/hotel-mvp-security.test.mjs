import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
const migrationPath=new URL('./migrations/20261022000000_hotel_mvp_phase_0_1/migration.sql',import.meta.url);
describe('hotel MVP database security',()=>{
 it('forces organization/property RLS on operational tables',async()=>{const sql=await readFile(migrationPath,'utf8');expect(sql).toContain('FORCE ROW LEVEL SECURITY');expect(sql).toContain('app.current_organization_id');expect(sql).toContain('app.current_hotel_property_id');});
 it.each(['hotel_reservation_stay_units','hotel_folio_postings','hotel_folio_payments'])('makes recorded money in %s immutable by trigger',async(table)=>{const sql=await readFile(migrationPath,'utf8');expect(sql).toContain(`ON "${table}"`);expect(sql).toContain('hotel_reject_immutable_money');});
});
