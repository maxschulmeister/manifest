import { QueryRunner } from 'typeorm';
import { AddAgentCompressionSettings1790200000000 } from './1790200000000-AddAgentCompressionSettings';

describe('AddAgentCompressionSettings1790200000000', () => {
  let migration: AddAgentCompressionSettings1790200000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAgentCompressionSettings1790200000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds compression boolean columns defaulting to false', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledTimes(3);
      const sql = queryRunner.query.mock.calls.map((c) => c[0] as string).join('\n');
      expect(sql).toContain('compress_prompt');
      expect(sql).toContain('compress_tool_output');
      expect(sql).toContain('compress_response');
      expect(sql).toContain('NOT NULL DEFAULT false');
    });
  });

  describe('down', () => {
    it('drops all compression columns', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledTimes(3);
      const sql = queryRunner.query.mock.calls.map((c) => c[0] as string).join('\n');
      expect(sql).toContain('DROP COLUMN IF EXISTS "compress_prompt"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "compress_tool_output"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "compress_response"');
    });
  });
});
