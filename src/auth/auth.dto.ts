import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
export const PASSWORD_MESSAGE = 'Password must be 8-128 characters and contain at least one letter and one digit.';

export const DEVICE_ID_RULE = /^[A-Za-z0-9_-]{8,64}$/;

export class DeviceInfoDto {
  /** Opaque id generated once by the desktop app (UUID v7) and stored locally. */
  @Matches(DEVICE_ID_RULE, { message: 'deviceId is invalid' }) deviceId: string;
  @IsString() @Length(1, 100) deviceName: string;
  @IsOptional() @IsString() @MaxLength(50) platform?: string;
  @IsOptional() @IsString() @MaxLength(30) appVersion?: string;
}

export class RegisterDto extends DeviceInfoDto {
  @IsOptional() @IsString() @Length(2, 120) businessName?: string;
  @IsString() @Length(2, 120) fullName: string;
  @IsEmail() @MaxLength(254) email: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
}

export class LoginDto extends DeviceInfoDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}

export class RefreshDto {
  @IsString() @MaxLength(2048) refreshToken: string;
  @IsOptional() @Matches(DEVICE_ID_RULE, { message: 'deviceId is invalid' }) deviceId?: string;
}

export class ForgotPasswordDto {
  @IsEmail() email: string;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(200) token: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}
