import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject } from 'class-validator';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

export class PasskeyRegistrationFinishDto {
  @ApiProperty({
    description:
      'The RegistrationResponseJSON produced by navigator.credentials.create() for the new passkey.',
  })
  @IsObject()
  @IsNotEmpty()
  response: RegistrationResponseJSON;
}
