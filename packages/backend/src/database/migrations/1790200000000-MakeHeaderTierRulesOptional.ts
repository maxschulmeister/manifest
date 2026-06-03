import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeHeaderTierRulesOptional1790200000000 implements MigrationInterface {
  name = 'MakeHeaderTierRulesOptional1790200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "header_tiers" ALTER COLUMN "header_key" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "header_tiers" ALTER COLUMN "header_value" DROP NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "header_tiers" SET "header_key" = 'x-manifest-tier' WHERE "header_key" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "header_tiers" SET "header_value" = "id" WHERE "header_value" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "header_tiers" ALTER COLUMN "header_value" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "header_tiers" ALTER COLUMN "header_key" SET NOT NULL`);
  }
}
