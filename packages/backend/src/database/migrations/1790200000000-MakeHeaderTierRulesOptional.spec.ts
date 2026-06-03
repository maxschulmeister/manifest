import { MakeHeaderTierRulesOptional1790200000000 } from './1790200000000-MakeHeaderTierRulesOptional';

describe('MakeHeaderTierRulesOptional1790200000000', () => {
  let migration: MakeHeaderTierRulesOptional1790200000000;
  let queryRunner: { query: jest.Mock };

  beforeEach(() => {
    migration = new MakeHeaderTierRulesOptional1790200000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  it('drops NOT NULL constraints from header tier rule columns', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migration.up(queryRunner as any);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      1,
      `ALTER TABLE "header_tiers" ALTER COLUMN "header_key" DROP NOT NULL`,
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      `ALTER TABLE "header_tiers" ALTER COLUMN "header_value" DROP NOT NULL`,
    );
  });

  it('fills null rules before restoring NOT NULL constraints', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migration.down(queryRunner as any);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      1,
      `UPDATE "header_tiers" SET "header_key" = 'x-manifest-tier' WHERE "header_key" IS NULL`,
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      `UPDATE "header_tiers" SET "header_value" = "id" WHERE "header_value" IS NULL`,
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      3,
      `ALTER TABLE "header_tiers" ALTER COLUMN "header_value" SET NOT NULL`,
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      4,
      `ALTER TABLE "header_tiers" ALTER COLUMN "header_key" SET NOT NULL`,
    );
  });
});
