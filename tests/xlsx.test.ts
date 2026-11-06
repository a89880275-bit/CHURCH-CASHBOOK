import { expect, it } from 'vitest';
import { workbook } from '../server/xlsx';
import { unzip } from './xlsx-utils';
it('exports typed amounts and safely preserves Korean, XML characters and formula-looking text without formulas',()=>{
  const files=unzip(workbook([['한글 <>&"', '=HYPERLINK("https://example.org")',50000,null],['개행\n비고\u0001',Number.MAX_SAFE_INTEGER]]));
  expect(Object.keys(files)).toHaveLength(6);
  const sheet=files['xl/worksheets/sheet1.xml'];
  expect(sheet).toContain('한글 &lt;&gt;&amp;&quot;');expect(sheet).toContain('=HYPERLINK(');
  expect(sheet).not.toContain('<f>');expect(sheet).not.toContain('\u0001');expect(sheet).toContain('<c r="C1" s="1"><v>50000</v></c>');expect(sheet).toContain('미설정');
  expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">9007199254740991</t></is></c>');
  expect(files['xl/workbook.xml']).toContain('수입지출장부');expect(files['xl/styles.xml']).toContain('numFmtId="3"');
});
