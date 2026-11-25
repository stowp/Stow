import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleTier } from '../../common/decorators/throttle-tier.decorator';
import { User } from '../../users/entities/user.entity';
import {
  ConfirmTwoFactorResetDto,
  EnableTwoFactorDto,
  RequestTwoFactorResetDto,
} from './dto/two-factor.dto';
import { TwoFactorService } from './two-factor.service';

@Controller('auth/2fa')
@ThrottleTier('auth')
export class TwoFactorController {
  constructor(private readonly twoFactorService: TwoFactorService) {}

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start TOTP setup; returns secret and QR code' })
  setup(@CurrentUser() user: User) {
    return this.twoFactorService.setup(user);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Confirm a code and enable 2FA; returns backup codes once',
  })
  enable(@CurrentUser() user: User, @Body() dto: EnableTwoFactorDto) {
    return this.twoFactorService.enable(user, dto.code);
  }

  @Public()
  @Post('reset/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a 2FA reset token' })
  async requestReset(@Body() dto: RequestTwoFactorResetDto) {
    await this.twoFactorService.requestReset(dto.email);
    return {
      message:
        'If two-factor authentication is enabled for this email, a reset token has been sent.',
    };
  }

  @Public()
  @Post('reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA using the emailed reset token' })
  async confirmReset(@Body() dto: ConfirmTwoFactorResetDto) {
    await this.twoFactorService.confirmReset(dto.token);
    return { success: true };
  }
}
