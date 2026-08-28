import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

export class PasskeyRegistrationBeginDto {
  @ApiProperty({
    required: false,
    example: 'alice_saver',
    description:
      "Display name shown by the authenticator/browser UI for the new passkey. Defaults to the caller's existing username or Stellar address when omitted.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  display_name?: string;
}

export class PasskeyRegistrationFinishDto {
  @ApiProperty({
    description:
      'The RegistrationResponseJSON produced by navigator.credentials.create() for the new passkey.',
  })
  @IsObject()
  @IsNotEmpty()
  response: RegistrationResponseJSON;
}
