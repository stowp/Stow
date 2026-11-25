import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { STELLAR_ACCOUNT_ADDRESS_PATTERN } from '../../dto/stellar-address.dto';

export class MergeSavingsAccountsDto {
  @ApiProperty({
    description: 'Account to merge away; it is archived afterwards',
  })
  @IsString()
  @Matches(STELLAR_ACCOUNT_ADDRESS_PATTERN, {
    message: 'source_owner must be a valid Stellar account address',
  })
  source_owner: string;

  @ApiProperty({
    description: 'Account that receives the balance, goals and plans',
  })
  @IsString()
  @Matches(STELLAR_ACCOUNT_ADDRESS_PATTERN, {
    message: 'target_owner must be a valid Stellar account address',
  })
  target_owner: string;
}
