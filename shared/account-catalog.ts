import { z } from 'zod';
const label=(max:number)=>z.string().trim().min(1).max(max);
export const standardAccountFields=z.object({code:label(30),type:z.enum(['INCOME','EXPENSE']),majorCategory:label(80),minorCategory:label(80),name:label(100),status:z.enum(['ACTIVE','INACTIVE']),sortOrder:z.number().int().min(0).max(999999),isDefault:z.boolean().optional(),treatment:z.enum(['NORMAL','OPENING_BALANCE','REFUND_REVIEW']).optional(),seedKey:label(80).optional()}).strict();
export const standardAccountSchema=standardAccountFields.extend({id:z.uuid(),version:z.number().int().positive(),createdAt:z.iso.datetime(),createdBy:z.uuid(),updatedAt:z.iso.datetime(),updatedBy:z.uuid()}).strict();
export type StandardAccount=z.infer<typeof standardAccountSchema>;
export const normalizeAccountText=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleUpperCase('en-US');
