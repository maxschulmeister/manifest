import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentCompressionSettings1790200000000 implements MigrationInterface {
  name = 'AddAgentCompressionSettings1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "compress_prompt" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "compress_tool_output" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "compress_response" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "compress_prompt"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "compress_tool_output"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "compress_response"`);
  }
}
