import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class VerifyChallengeDto {
  @IsString()
  @IsNotEmpty()
  stellar_address: string;

  @IsString()
  @IsNotEmpty()
  signed_challenge: string;

  /** Required only when the account has two-factor authentication enabled. */
  @IsOptional()
  @IsString()
  two_factor_code?: string;
}
