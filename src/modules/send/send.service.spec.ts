import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { SendService } from './send.service';
import { AppException, ErrorCode } from '../../common/errors';

describe('SendService - stroop conversion helpers (#103)', () => {
  let service: SendService;

  beforeEach(() => {
    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return 'GBEXAMPLE';
        return null;
      }),
    } as unknown as ConfigService;

    const mockStellar = {} as unknown as StellarService;
    const mockUsers = {} as unknown as UsersRepository;

    service = new SendService(mockConfig, mockStellar, mockUsers);
  });

  describe('toStroops and fromStroops conversions', () => {
    // Typed test accessor for private helpers
    const toStroops = (amount: string): bigint =>
      (service as any).toStroops(amount);

    const fromStroops = (stroops: bigint): string =>
      (service as any).fromStroops(stroops);

    it('converts whole units correctly ("1" -> 10,000,000 stroops)', () => {
      expect(toStroops('1')).toBe(10_000_000n);
      expect(fromStroops(10_000_000n)).toBe('1');
    });

    it('round-trips standard and fractional amounts accurately', () => {
      const testCases = ['1', '0.0000001', '0.1234567', '1000'];
      for (const amount of testCases) {
        const stroops = toStroops(amount);
        const reconstructed = fromStroops(stroops);
        expect(reconstructed).toBe(amount);
      }
    });

    it('trims trailing zeros correctly so that "1.5000000" renders as "1.5"', () => {
      const stroops = toStroops('1.5000000');
      expect(stroops).toBe(15_000_000n);
      expect(fromStroops(stroops)).toBe('1.5');
    });

    it('handles exact zero decimal part cleanly', () => {
      expect(fromStroops(0n)).toBe('0');
      expect(fromStroops(100_000_000n)).toBe('10');
    });

    it('rejects invalid, negative, or malformed amounts with AppException(INVALID_AMOUNT)', () => {
      const invalidAmounts = ['0', '-1', '1.12345678', 'abc', '', '..', '1.'];

      for (const invalid of invalidAmounts) {
        expect(() => toStroops(invalid)).toThrow(
          expect.objectContaining({
            code: ErrorCode.INVALID_AMOUNT,
          }),
        );
      }
    });
  });
});
