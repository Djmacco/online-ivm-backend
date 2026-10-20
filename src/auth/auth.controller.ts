import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClientIp, CurrentUser, Public } from '../common/decorators';
import { AuthUser } from '../common/types';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto } from './auth.dto';
import { AuthService } from './auth.service';

// Brute-force protection on top of per-account lockout.
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle(STRICT) @Post('register')
  register(@Body() dto: RegisterDto, @ClientIp() ip?: string) {
    return this.auth.register(dto, ip);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('login')
  login(@Body() dto: LoginDto, @ClientIp() ip?: string) {
    return this.auth.login(dto, ip);
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @HttpCode(200) @Post('refresh')
  refresh(@Body() dto: RefreshDto, @ClientIp() ip?: string) {
    return this.auth.refresh(dto.refreshToken, dto.deviceId, ip);
  }

  @ApiBearerAuth() @HttpCode(200) @Post('logout')
  logout(@Body() dto: RefreshDto, @CurrentUser() user: AuthUser, @ClientIp() ip?: string) {
    return this.auth.logout(dto.refreshToken, user, ip);
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post('forgot-password')
  forgot(@Body() dto: ForgotPasswordDto, @ClientIp() ip?: string) {
    return this.auth.forgotPassword(dto.email, ip);
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post('reset-password')
  reset(@Body() dto: ResetPasswordDto, @ClientIp() ip?: string) {
    return this.auth.resetPassword(dto, ip);
  }

  @ApiBearerAuth() @HttpCode(200) @Post('change-password')
  change(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser, @ClientIp() ip?: string) {
    return this.auth.changePassword(user, dto, ip);
  }

  @ApiBearerAuth() @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
