import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

export class EnableTwoFactorDto {
  @ApiProperty({ description: 'Six-digit code from the authenticator app' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;
}

export class RequestTwoFactorResetDto {
  @ApiProperty({ description: 'Email address on the account' })
  @IsEmail()
  email: string;
}

export class ConfirmTwoFactorResetDto {
  @ApiProperty({ description: 'Reset token from the email' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
