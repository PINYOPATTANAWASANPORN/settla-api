import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SendService } from './send.service';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { AppException, ErrorCode } from '../../common/errors';

describe('SendService', () => {
  let service: SendService;
  let configService: { get: jest.Mock };
  let stellarService: {
    getBalances: jest.Mock;
    buildUnsignedUsdcSend: jest.Mock;
    submitSignedXdr: jest.Mock;
  };
  let usersRepository: {
    findByPublicKey: jest.Mock;
    findByAlias: jest.Mock;
  };

  const VALID_STELLAR_ADDRESS_1 =
    'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTCVQPTYEQGIFO';
  const VALID_STELLAR_ADDRESS_2 =
    'GA2H7FUBASEKCXYOrHNT42Z9B8VEXEM462K6XGYKHYN4M33I7QOPP2X5'.slice(0, 56);
  const TREASURY_ADDRESS =
    'GCDNWU7O4M4PGBKFMQO6US56S24UJJ7Y5E6XG4U777Y3RUXNEXEXAMPLE';

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return TREASURY_ADDRESS;
        return null;
      }),
    };

    stellarService = {
      getBalances: jest.fn(),
      buildUnsignedUsdcSend: jest.fn(),
      submitSignedXdr: jest.fn(),
    };

    usersRepository = {
      findByPublicKey: jest.fn(),
      findByAlias: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendService,
        { provide: ConfigService, useValue: configService },
        { provide: StellarService, useValue: stellarService },
        { provide: UsersRepository, useValue: usersRepository },
      ],
    }).compile();

    service = module.get<SendService>(SendService);
  });

  describe('resolveRecipient (#104)', () => {
    it('resolves a direct Stellar public key without alias lookup', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockResolvedValue([
        { asset_code: 'USDC', balance: '100.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: null,
        exists: true,
        hasUsdcTrustline: true,
      });
      expect(usersRepository.findByPublicKey).toHaveBeenCalledWith(
        VALID_STELLAR_ADDRESS_1,
      );
    });

    it('resolves a direct Stellar public key with linked user alias', async () => {
      usersRepository.findByPublicKey.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_1,
        alias: 'alice',
      });
      stellarService.getBalances.mockResolvedValue([
        { asset_type: 'native', balance: '50.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: 'alice',
        exists: true,
        hasUsdcTrustline: false,
      });
    });

    it('resolves a known alias to its underlying address and alias', async () => {
      usersRepository.findByAlias.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_2,
        alias: 'bob',
      });
      stellarService.getBalances.mockResolvedValue([
        { asset_code: 'USDC', balance: '25.0000000' },
      ]);

      const result = await service.resolveRecipient('bob');

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_2,
        alias: 'bob',
        exists: true,
        hasUsdcTrustline: true,
      });
      expect(usersRepository.findByAlias).toHaveBeenCalledWith('bob');
    });

    it('throws AppException with INVALID_RECIPIENT for an unknown alias', async () => {
      usersRepository.findByAlias.mockResolvedValue(null);

      await expect(service.resolveRecipient('unknown_alias')).rejects.toThrow(
        AppException,
      );

      try {
        await service.resolveRecipient('unknown_alias');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.INVALID_RECIPIENT);
      }
    });

    it('sets hasUsdcTrustline to true only when balance has asset_code USDC', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockResolvedValue([
        { asset_type: 'native', balance: '10.0000000' },
        { asset_code: 'EURC', balance: '5.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result.exists).toBe(true);
      expect(result.hasUsdcTrustline).toBe(false);
    });

    it('swallows getBalances rejection and returns exists = false without throwing', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockRejectedValue(
        new Error('Account not found on Horizon'),
      );

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: null,
        exists: false,
        hasUsdcTrustline: false,
      });
    });
  });

  describe('prepare (#102)', () => {
    it('throws AppException with SELF_SEND if recipient resolves to sourcePublicKey', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(VALID_STELLAR_ADDRESS_1, VALID_STELLAR_ADDRESS_1, '10'),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_1,
          '10',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.SELF_SEND);
      }

      expect(stellarService.buildUnsignedUsdcSend).not.toHaveBeenCalled();
    });

    it('throws AppException with AMOUNT_TOO_SMALL when fee calculates to 0 stroops', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '0.0000001',
        ),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '0.0000001',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.AMOUNT_TOO_SMALL);
      }
    });

    it('throws AppException with MISSING_FEE_COLLECTOR when IKASH_TREASURY_ADDRESS is not set', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return null;
        return null;
      });
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(VALID_STELLAR_ADDRESS_1, VALID_STELLAR_ADDRESS_2, '1'),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '1',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.MISSING_FEE_COLLECTOR);
      }
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 1', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_1',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        VALID_STELLAR_ADDRESS_2,
        '1',
      );

      expect(res.amount).toBe('1');
      expect(res.fee).toBe('0.003');
      expect(res.total).toBe('1.003');
      expect(res.asset).toBe('USDC');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_1');
      expect(stellarService.buildUnsignedUsdcSend).toHaveBeenCalledWith({
        sourcePublicKey: VALID_STELLAR_ADDRESS_1,
        destination: VALID_STELLAR_ADDRESS_2,
        amount: '1',
        feeAddress: TREASURY_ADDRESS,
        feeAmount: '0.003',
      });
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 0.1234567', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_2',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        VALID_STELLAR_ADDRESS_2,
        '0.1234567',
      );

      expect(res.amount).toBe('0.1234567');
      expect(res.fee).toBe('0.0003703');
      expect(res.total).toBe('0.123827');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_2');
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 1000', async () => {
      usersRepository.findByAlias.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_2,
        alias: 'carol',
      });
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_3',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        'carol',
        '1000',
      );

      expect(res.recipient).toEqual({
        address: VALID_STELLAR_ADDRESS_2,
        alias: 'carol',
      });
      expect(res.amount).toBe('1000');
      expect(res.fee).toBe('3');
      expect(res.total).toBe('1003');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_3');
    });
  });

  describe('submit', () => {
    it('delegates signed XDR submission to StellarService', async () => {
      stellarService.submitSignedXdr.mockResolvedValue({
        hash: 'tx-hash-123',
        ledger: 12345,
        successful: true,
      });

      const res = await service.submit('SIGNED_XDR_DATA');

      expect(res).toEqual({
        hash: 'tx-hash-123',
        ledger: 12345,
        successful: true,
      });
      expect(stellarService.submitSignedXdr).toHaveBeenCalledWith(
        'SIGNED_XDR_DATA',
      );
    });
  });
});
