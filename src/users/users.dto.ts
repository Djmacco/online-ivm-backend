import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { PASSWORD_MESSAGE, PASSWORD_RULE } from '../auth/auth.dto';

export enum RoleDto { ADMIN = 'ADMIN', MANAGER = 'MANAGER', STAFF = 'STAFF' }

export class CreateUserDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @Length(2, 120) fullName: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
  @IsEnum(RoleDto) role: RoleDto;
  /** Optional explicit permission list (overrides role defaults). */
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) permissions?: string[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 120) fullName?: string;
  @IsOptional() @IsEnum(RoleDto) role?: RoleDto;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) permissions?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword?: string;
}
