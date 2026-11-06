import { describe, expect, it } from 'vitest';
import { currentPeriod, periodRange } from '../shared/period';
describe('department calendar defaults',()=>{
  it('chooses the whole year for low-volume annual management',()=>{expect(currentPeriod('YEARLY','2026-11-06')).toEqual({from:'2026-01-01',to:'2026-12-31'});});
  it('chooses the current calendar month for monthly management',()=>{expect(currentPeriod('MONTHLY','2026-11-06')).toEqual({from:'2026-11-01',to:'2026-11-30'});});
  it('handles leap years and December/year boundaries',()=>{expect(periodRange('MONTHLY',2028,2).to).toBe('2028-02-29');expect(periodRange('MONTHLY',2100,2).to).toBe('2100-02-28');expect(currentPeriod('YEARLY','2027-01-01').from).toBe('2027-01-01');});
});
