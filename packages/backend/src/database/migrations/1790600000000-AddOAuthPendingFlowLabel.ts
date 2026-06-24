import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOAuthPendingFlowLabel1790600000000 implements MigrationInterface {
  name = 'AddOAuthPendingFlowLabel1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "oauth_pending_flows" ADD "label" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "oauth_pending_flows" DROP COLUMN "label"`);
  }
}
