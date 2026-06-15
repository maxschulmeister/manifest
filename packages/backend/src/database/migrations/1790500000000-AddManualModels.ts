import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `manual_models` to `user_providers` — operator-added models for an
 * integrated provider whose `/models` endpoint omits them. Stored as a
 * simple-json text column, matching `cached_models`. `discoverModels()`
 * merges this list into `cached_models` on every refresh, so manual models
 * persist across refresh and flow through the standard routing path.
 */
export class AddManualModels1790500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_providers" ADD COLUMN IF NOT EXISTS "manual_models" text DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_providers" DROP COLUMN IF EXISTS "manual_models"`);
  }
}
