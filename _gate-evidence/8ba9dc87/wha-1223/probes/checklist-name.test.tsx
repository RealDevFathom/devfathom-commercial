import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ReadinessChecklistItem } from '@/components/onboarding/readiness-checklist';
afterEach(cleanup);
it('proves the authored exact name omits the real checklist accessible suffix', () => {
 render(<ReadinessChecklistItem row={{key:'BRANCHES_AND_LOCATIONS',step:4,label:'Branches and locations',state:'NEEDS_YOU',why:'Setup required',href:'/pharmacy/inventory',linkLabel:'Create or review stock locations'}} />);
 expect(screen.queryByRole('link',{name:'Create or review stock locations',exact:true})).toBeNull();
 expect(screen.getByRole('link',{name:/^Create or review stock locations\s*— Branches and locations$/})).toHaveAttribute('href','/pharmacy/inventory');
});
